import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { Order } from '../types/order';
import { addToQueue } from '../services/queue';
import { createClient } from 'redis';
import * as dotenv from 'dotenv';

dotenv.config();

const createRedisClient = () => {
  return createClient({ url: process.env.REDIS_URL });
};

export default async function orderController(fastify: FastifyInstance) {
  // POST endpoint for order submission
  fastify.post('/api/orders/execute', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { tokenIn: string; tokenOut: string; amount: number };
    
    // Validate order
    if (!body.tokenIn || !body.tokenOut || !body.amount || body.amount <= 0) {
      return reply.status(400).send({ error: 'Invalid order parameters' });
    }

    const order: Order = {
      orderId: uuidv4(),
      type: 'market',
      tokenIn: body.tokenIn,
      tokenOut: body.tokenOut,
      amount: body.amount,
      status: 'pending',
      timestamp: new Date().toISOString()
    };

    const redisClient = createRedisClient();
    try {
      await redisClient.connect();
      // Store initial order state
      await redisClient.set(order.orderId, JSON.stringify(order));
      
      // Add to processing queue
      await addToQueue(order);
    } catch (err) {
      console.error('Error during order submission:', err);
      return reply.status(500).send({ error: 'Failed to process order' });
    } finally {
      if (redisClient.isOpen) {
        await redisClient.disconnect();
      }
    }

    return reply.status(200).send({ 
      orderId: order.orderId,
      status: 'pending',
      message: 'Order submitted successfully. Connect to WebSocket for live updates.'
    });
  });

  // WebSocket endpoint for live updates
  fastify.get('/api/orders/:orderId/status', { websocket: true }, async (connection, req: FastifyRequest) => {
    const params = req.params as { orderId: string };
    const query = req.query as { loop?: string };
    let orderId = params.orderId;
    const loopMode = query.loop === 'true';

    if (!orderId) {
      connection.socket.send(JSON.stringify({ error: 'Order ID required' }));
      connection.socket.close(1000, 'Order ID required');
      return;
    }

    console.log(`WebSocket connection established for order: ${orderId}`);

    const redisClient = createRedisClient();
    let interval: NodeJS.Timeout | null = null;
    let isConnected = true;
    let lastHistoryIndex = 0; // number of history entries already sent
    let templateOrder: Order | null = null; // used to auto-generate new orders in loop mode

    try {
      await redisClient.connect();
      console.log(`Redis connected for WebSocket order: ${orderId}`);

      // Check if order exists
      const orderData = await redisClient.get(orderId);
      if (!orderData) {
        connection.socket.send(JSON.stringify({ error: 'Order not found' }));
        connection.socket.close(1000, 'Order not found');
        await redisClient.disconnect();
        return;
      }

      const order = JSON.parse(orderData) as Order;
      templateOrder = order;
      
      // Always send a connection confirmation as the first message
      const initialMessage = {
        orderId: order.orderId,
        status: order.status,
        message: loopMode ? 'Connected to order status stream (LOOP MODE - will keep running)' : 'Connected to order status stream',
        timestamp: new Date().toISOString(),
        loopMode: loopMode,
        kind: 'connected'
      };
      console.log(`Sending initial status for order ${orderId}: ${order.status} (loop mode: ${loopMode})`);
      connection.socket.send(JSON.stringify(initialMessage));

      // Optionally send existing history if list API is available
      const hasListApi = typeof (redisClient as any).lRange === 'function';
      if (hasListApi) {
        const historyList = await (redisClient as any).lRange(`history:${orderId}`, 0, -1);
        lastHistoryIndex = historyList.length;
        for (const item of historyList) {
          const historyEntry = JSON.parse(item);
          connection.socket.send(JSON.stringify({
            ...historyEntry,
            kind: 'history',
            loopMode
          }));
        }
      }

      // Set up status polling
      interval = setInterval(async () => {
        try {
          if (!isConnected || !redisClient.isOpen) {
            console.log(`WebSocket disconnected for order ${orderId}, stopping polling`);
            if (interval) clearInterval(interval);
            return;
          }

          // Send any new history entries since last tick (if list API available)
          const hasListApiTick = typeof (redisClient as any).lLen === 'function' && typeof (redisClient as any).lRange === 'function';
          if (hasListApiTick) {
            const currentLen = await (redisClient as any).lLen(`history:${orderId}`);
            if (currentLen > lastHistoryIndex) {
              const newItems = await (redisClient as any).lRange(`history:${orderId}`, lastHistoryIndex, -1);
              for (const item of newItems) {
                const historyEntry = JSON.parse(item);
                console.log(`Sending history step for order ${orderId}: ${historyEntry.status}`);
                connection.socket.send(JSON.stringify({
                  ...historyEntry,
                  kind: 'history',
                  loopMode
                }));
              }
              lastHistoryIndex = currentLen;
            }
          }

          const stored = await redisClient.get(orderId);
          if (stored) {
            const latest = JSON.parse(stored) as Order;
            const updateMessage = {
              ...latest,
              timestamp: new Date().toISOString(),
              loopMode: loopMode,
              message: loopMode && ['confirmed', 'failed'].includes(latest.status) 
                ? `Order completed - Status: ${latest.status} (LOOP MODE - still running)`
                : undefined,
              kind: 'snapshot'
            };
            connection.socket.send(JSON.stringify(updateMessage));
            
            // Close connection when order is complete (unless in loop mode)
            if (['confirmed', 'failed'].includes(latest.status)) {
              if (loopMode) {
                console.log(`Order ${orderId} completed with status: ${latest.status}, continuing in loop mode`);
                // Auto-generate a new order based on the original template and switch tracking to it
                if (templateOrder) {
                  const newOrder: Order = {
                    orderId: uuidv4(),
                    type: 'market',
                    tokenIn: templateOrder.tokenIn,
                    tokenOut: templateOrder.tokenOut,
                    amount: templateOrder.amount,
                    status: 'pending',
                    timestamp: new Date().toISOString()
                  };

                  // Reset tracking for new order
                  orderId = newOrder.orderId;
                  lastHistoryIndex = 0;

                  // Store and enqueue
                  await redisClient.set(orderId, JSON.stringify(newOrder));
                  await redisClient.del(`history:${orderId}`); // ensure clean history for the new one
                  await addToQueue(newOrder);

                  // Notify client about new cycle
                  connection.socket.send(JSON.stringify({
                    kind: 'cycle',
                    message: 'Starting new order cycle in loop mode',
                    orderId,
                    tokenIn: newOrder.tokenIn,
                    tokenOut: newOrder.tokenOut,
                    amount: newOrder.amount,
                    timestamp: new Date().toISOString(),
                    loopMode: true
                  }));
                }
              } else {
                console.log(`Order ${orderId} completed with status: ${latest.status}, closing WebSocket`);
                setTimeout(() => {
                  if (isConnected) {
                    connection.socket.close(1000, 'Order completed');
                  }
                }, 1000); // Give a small delay to ensure the message is sent
              }
            }
          } else {
            console.log(`Order ${orderId} not found in Redis, closing WebSocket`);
            connection.socket.send(JSON.stringify({ 
              error: 'Order not found in database',
              orderId 
            }));
            setTimeout(() => {
              if (isConnected) {
                connection.socket.close(1000, 'Order not found');
              }
            }, 1000);
          }
        } catch (error) {
          console.error(`Error polling order status for ${orderId}:`, error);
          connection.socket.send(JSON.stringify({ 
            error: 'Failed to get order status',
            orderId,
            details: error instanceof Error ? error.message : 'Unknown error'
          }));
        }
      }, 1000); // Poll every second

    } catch (error) {
      console.error(`Redis connection error for WebSocket order ${orderId}:`, error);
      connection.socket.send(JSON.stringify({ 
        error: 'Internal server error',
        orderId,
        details: error instanceof Error ? error.message : 'Unknown error'
      }));
      connection.socket.close(1011, 'Internal server error');
      return;
    }

    // Clean up on connection close
    connection.socket.on('close', async (code, reason) => {
      if (process.env.NODE_ENV !== 'test') {
        console.log(`WebSocket closed for order ${orderId}, code: ${code}, reason: ${reason}`);
      }
      isConnected = false;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      if (redisClient.isOpen) {
        await redisClient.disconnect();
      }
    });

    connection.socket.on('error', async (error) => {
      if (process.env.NODE_ENV !== 'test') {
        console.error(`WebSocket error for order ${orderId}:`, error);
      }
      isConnected = false;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      if (redisClient.isOpen) {
        await redisClient.disconnect();
      }
    });

    // Handle ping/pong to keep connection alive
    connection.socket.on('ping', () => {
      connection.socket.pong();
    });
  });

  // (removed debug endpoint to keep route tree stable for tests)

  // GET endpoint to check order status (for testing)
  fastify.get('/api/orders/:orderId', async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { orderId: string };
    const query = request.query as { poll?: string; interval?: string; includeHistory?: string };
    const orderId = params.orderId;
    const shouldPoll = query.poll === 'true';
    const pollInterval = parseInt(query.interval || '1000');
    const includeHistory = query.includeHistory === 'true';

    const redisClient = createRedisClient();
    try {
        await redisClient.connect();
        
        if (shouldPoll) {
          // Set up Server-Sent Events for polling
          reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Cache-Control'
          });

          const pollStatus = async () => {
            try {
              const orderData = await redisClient.get(orderId);
              if (!orderData) {
                reply.raw.write(`data: ${JSON.stringify({ error: 'Order not found' })}\n\n`);
                return;
              }

              const order = JSON.parse(orderData) as Order;
              if (includeHistory) {
                const history = await redisClient.lRange(`history:${orderId}`, 0, -1);
                const parsed = history.map(h => JSON.parse(h));
                reply.raw.write(`data: ${JSON.stringify({ order, history: parsed })}\n\n`);
              } else {
                reply.raw.write(`data: ${JSON.stringify(order)}\n\n`);
              }
              
              // Stop polling when order is complete
              if (['confirmed', 'failed'].includes(order.status)) {
                reply.raw.end();
                if (redisClient.isOpen) {
                  await redisClient.disconnect();
                }
                return;
              }
            } catch (error) {
              console.error('Error polling order status:', error);
              reply.raw.write(`data: ${JSON.stringify({ error: 'Failed to get order status' })}\n\n`);
            }
          };

          // Send initial status
          await pollStatus();
          
          // Set up interval for polling
          const interval = setInterval(pollStatus, pollInterval);
          
          // Clean up on connection close
          reply.raw.on('close', () => {
            clearInterval(interval);
            if (redisClient.isOpen) {
              redisClient.disconnect();
            }
          });
          
        } else {
          // Single status check
          const orderData = await redisClient.get(orderId);
          if (!orderData) {
            return reply.status(404).send({ error: 'Order not found' });
          }

          const order = JSON.parse(orderData) as Order;
          if (includeHistory) {
            const history = await redisClient.lRange(`history:${orderId}`, 0, -1);
            const parsed = history.map(h => JSON.parse(h));
            return reply.status(200).send({ order, history: parsed });
          }
          return reply.status(200).send(order);
        }
    } catch (err) {
        console.error('Error fetching order status:', err);
        return reply.status(500).send({ error: 'Failed to fetch order status' });
    } finally {
        if (!shouldPoll && redisClient.isOpen) {
            await redisClient.disconnect();
        }
    }
  });
}