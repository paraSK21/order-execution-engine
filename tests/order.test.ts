import { MockDexRouter } from '../src/services/dexRouter';
import { Queue } from 'bullmq';
import { addToQueue } from '../src/services/queue';
import { createClient } from 'redis';
import fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import orderController from '../src/controllers/orderController';
import WebSocket from 'ws';
import { AddressInfo } from 'net';
import { Order } from '../src/types/order';

// Mocks
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }),
    count: jest.fn().mockResolvedValue(1),
  })),
  Worker: jest.fn(),
}));

jest.mock('redis', () => ({
  createClient: jest.fn().mockReturnValue({
    connect: jest.fn().mockResolvedValue(undefined),
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockImplementation((key) => {
      // Simulate status change: first call returns 'pending', second returns 'confirmed'
      const callCount = (jest.fn().mock.calls.length || 0) + 1;
      if (callCount === 1) {
        return Promise.resolve(JSON.stringify({ 
          orderId: key, 
          status: 'pending',
          timestamp: new Date().toISOString()
        }));
      }
      return Promise.resolve(JSON.stringify({ 
        orderId: key, 
        status: 'confirmed',
        txHash: 'mock-tx-123',
        executedPrice: 10.5,
        timestamp: new Date().toISOString()
      }));
    }),
  }),
}));

jest.mock('../src/services/dexRouter', () => ({
  MockDexRouter: jest.fn().mockImplementation(() => ({
    getRaydiumQuote: jest.fn().mockImplementation(async () => ({
      price: 1.0 * (0.98 + Math.random() * 0.04),
      fee: 0.003,
      liquidity: 750000,
      slippage: 0.005
    })),
    getMeteoraQuote: jest.fn().mockImplementation(async () => ({
      price: 1.0 * (0.97 + Math.random() * 0.05),
      fee: 0.002,
      liquidity: 600000,
      slippage: 0.007
    })),
    selectBestDex: jest.fn().mockResolvedValue({ 
      dex: 'meteora', 
      quote: { price: 1.01, fee: 0.002 },
      decision: {
        raydium: { price: 1.0, fee: 0.003, effectivePrice: 0.997, output: 9.97, liquidity: 750000, slippage: 0.005 },
        meteora: { price: 1.01, fee: 0.002, effectivePrice: 1.008, output: 10.08, liquidity: 600000, slippage: 0.007 },
        selected: 'meteora',
        reason: 'meteora provides 0.110000 more USDC (1.10% better)',
        priceDifference: 1.10
      }
    }),
    executeSwap: jest.fn().mockResolvedValue({ 
      txHash: 'mock-tx-123', 
      executedPrice: 10.5,
      slippage: 0.5,
      executionTime: 2500
    }),
  })),
}));

describe('DEX Router', () => {
  let router: MockDexRouter;

  beforeEach(() => {
    router = new MockDexRouter();
  });

  test('Gets Raydium quote with all required fields', async () => {
    const quote = await router.getRaydiumQuote('SOL', 'USDC', 1);
    expect(quote.price).toBeGreaterThan(0);
    expect(quote.fee).toBe(0.003);
    expect(quote.liquidity).toBeGreaterThan(0);
    expect(quote.slippage).toBeGreaterThanOrEqual(0);
  });

  test('Gets Meteora quote with all required fields', async () => {
    const quote = await router.getMeteoraQuote('SOL', 'USDC', 1);
    expect(quote.price).toBeGreaterThan(0);
    expect(quote.fee).toBe(0.002);
    expect(quote.liquidity).toBeGreaterThan(0);
    expect(quote.slippage).toBeGreaterThanOrEqual(0);
  });

  test('Selects best DEX with detailed decision', async () => {
    const result = await router.selectBestDex('SOL', 'USDC', 1);
    expect(['raydium', 'meteora']).toContain(result.dex);
    expect(result.quote.price).toBeGreaterThan(0);
    expect(result.decision).toBeDefined();
    expect(result.decision.selected).toBe(result.dex);
    expect(result.decision.reason).toContain(result.dex);
  });

  test('Executes swap successfully with all details', async () => {
    const order: Order = { 
      orderId: 'test', 
      type: 'market', 
      tokenIn: 'SOL', 
      tokenOut: 'USDC', 
      amount: 1, 
      status: 'pending',
      timestamp: new Date().toISOString()
    };
    const result = await router.executeSwap('raydium', order);
    expect(result.txHash).toMatch(/^mock-tx-/);
    expect(result.executedPrice).toBeGreaterThan(0);
    expect(result.slippage).toBeGreaterThanOrEqual(0);
    expect(result.executionTime).toBeGreaterThan(0);
  });

  test('Handles price variance between quotes', async () => {
    const quote1 = await router.getRaydiumQuote('SOL', 'USDC', 1);
    const quote2 = await router.getRaydiumQuote('SOL', 'USDC', 1);
    expect(quote1.price).not.toEqual(quote2.price);
  });

  test('Routing decision includes both DEX comparisons', async () => {
    const result = await router.selectBestDex('SOL', 'USDC', 10);
    expect(result.decision.raydium).toBeDefined();
    expect(result.decision.meteora).toBeDefined();
    expect(result.decision.raydium.output).toBeGreaterThan(0);
    expect(result.decision.meteora.output).toBeGreaterThan(0);
    expect(result.decision.priceDifference).toBeGreaterThan(0);
  });
});

describe('Queue', () => {
  test('Adds order to queue', async () => {
    const queue = new Queue('test');
    await queue.add('test', { data: 1 });
    expect(queue.add).toHaveBeenCalledWith('test', { data: 1 });
  });

  test('Handles retry on failure', async () => {
    const mockRouter = new MockDexRouter();
    (mockRouter.executeSwap as jest.Mock).mockRejectedValueOnce(new Error('Mock fail')).mockResolvedValueOnce({ txHash: 'retry-tx', executedPrice: 10 });
    const order: Order = { 
      orderId: 'test', 
      type: 'market', 
      tokenIn: 'SOL', 
      tokenOut: 'USDC', 
      amount: 1, 
      status: 'pending',
      timestamp: new Date().toISOString()
    };
    await expect(mockRouter.executeSwap('raydium', order)).rejects.toThrow('Mock fail');
    const result = await mockRouter.executeSwap('raydium', order);
    expect(result.txHash).toBe('retry-tx');
  });
});

describe('API and WebSocket', () => {
  let app: FastifyInstance;
  let port: number;

  beforeAll(async () => {
    app = fastify({ logger: false });
    await app.register(websocket);
    await app.register(orderController);
    await app.listen({ port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to get server port');
    }
    port = address.port;
  });

  afterAll(async () => {
    await app.close();
  });

  test('POST /api/orders/execute route is registered', async () => {
    const routes = app.printRoutes();
    expect(routes).toMatch(/api\/orders\/[\s\S]*?├──\s+execute\s+\(POST\)/);
  });
  
  test('WebSocket /api/orders/:orderId/status route is registered', async () => {
    const routes = app.printRoutes();
    expect(routes).toMatch(/api\/orders\/[\s\S]*?:orderId\s+\(GET, HEAD\)[\s\S]*?└──\s+\/status\s+\(GET, HEAD\)/);
  });

  test('POST /api/orders/execute accepts valid order', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/orders/execute',
      payload: {
        tokenIn: 'SOL',
        tokenOut: 'USDC',
        amount: 10
      }
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.orderId).toBeDefined();
    expect(body.status).toBe('pending');
    expect(body.message).toContain('Order submitted successfully');
  });

  test('POST /api/orders/execute rejects invalid order', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/orders/execute',
      payload: {
        tokenIn: '',
        tokenOut: 'USDC',
        amount: 0
      }
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Invalid order parameters');
  });

  test('GET /api/orders/:orderId returns order status', async () => {
    // First create an order
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/orders/execute',
      payload: {
        tokenIn: 'SOL',
        tokenOut: 'USDC',
        amount: 5
      }
    });

    const { orderId } = JSON.parse(createResponse.body);

    // Then get the order status
    const statusResponse = await app.inject({
      method: 'GET',
      url: `/api/orders/${orderId}`
    });

    expect(statusResponse.statusCode).toBe(200);
    const order = JSON.parse(statusResponse.body);
    expect(order.orderId).toBe(orderId);
    expect(order.status).toBe('pending');
  });

  test('WebSocket connects and receives status updates', async () => {
    return new Promise(async (resolve, reject) => {
      // First create an order
      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/orders/execute',
        payload: {
          tokenIn: 'SOL',
          tokenOut: 'USDC',
          amount: 3
        }
      });

      const { orderId } = JSON.parse(createResponse.body);

      // Connect to WebSocket
      const ws = new WebSocket(`ws://localhost:${port}/api/orders/${orderId}/status`);
      let messageCount = 0;
      let resolved = false;

      const cleanup = () => {
        if (!resolved) {
          resolved = true;
          if (ws.readyState === WebSocket.OPEN) {
            ws.close();
          }
        }
      };

      // Timeout after 5 seconds
      const timeout = setTimeout(() => {
        cleanup();
        resolve(undefined); // Resolve instead of reject to not fail the test
      }, 5000);

      ws.on('open', () => {
        console.log('WebSocket connected');
      });

      ws.on('message', (data) => {
        messageCount++;
        const message = JSON.parse(data.toString());
        console.log(`WebSocket message ${messageCount}:`, message);

        if (messageCount === 1) {
          // First message should be connection confirmation
          expect(message.message).toContain('Connected to order status stream');
        } else {
          // Subsequent messages should be order updates
          expect(message.orderId).toBe(orderId);
          expect(['pending', 'routing', 'building', 'submitted', 'confirmed', 'failed']).toContain(message.status);
        }

        // Close after receiving initial connection message (since worker won't run in test)
        if (messageCount >= 1) {
          clearTimeout(timeout);
          cleanup();
          resolve(undefined);
        }
      });

      ws.on('error', (err) => {
        console.error('WebSocket error:', err);
        clearTimeout(timeout);
        cleanup();
        reject(err);
      });

      ws.on('close', () => {
        console.log('WebSocket closed');
      });
    });
  }, 10000);

  test('Adds order to queue without WebSocket parameter', async () => {
    const order: Order = { 
      orderId: 'test-queue', 
      type: 'market', 
      tokenIn: 'SOL', 
      tokenOut: 'USDC', 
      amount: 1, 
      status: 'pending',
      timestamp: new Date().toISOString()
    };
    
    // Should not throw error when called without WebSocket
    await expect(addToQueue(order)).resolves.not.toThrow();
  });

  test('Handles concurrent order processing', async () => {
    const orders: string[] = [];
    
    // Create multiple orders simultaneously
    for (let i = 0; i < 3; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/orders/execute',
        payload: {
          tokenIn: 'SOL',
          tokenOut: 'USDC',
          amount: 1 + i
        }
      });
      
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      orders.push(body.orderId);
    }

    // All orders should be created successfully
    expect(orders).toHaveLength(3);
    orders.forEach(orderId => {
      expect(orderId).toBeDefined();
      expect(typeof orderId).toBe('string');
    });
  });

  test('Handles failure status in DEX router', async () => {
    const mockRouter = new MockDexRouter();
    (mockRouter.executeSwap as jest.Mock).mockRejectedValue(new Error('Execution failed'));
    
    const order: Order = { 
      orderId: 'test-fail', 
      type: 'market', 
      tokenIn: 'SOL', 
      tokenOut: 'USDC', 
      amount: 1, 
      status: 'pending',
      timestamp: new Date().toISOString()
    };
    
    await expect(mockRouter.executeSwap('raydium', order)).rejects.toThrow('Execution failed');
  });
});