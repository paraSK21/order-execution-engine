import { Queue, Worker } from 'bullmq';
import { MockDexRouter } from './dexRouter';
import { Order } from '../types/order';
import { createClient } from 'redis';
import * as dotenv from 'dotenv';

dotenv.config();

const redisConnection = { url: process.env.REDIS_URL || 'redis://localhost:6379' };
const queue = new Queue('processOrder', { connection: redisConnection });

// Database removed (not used)

const redisClient = createClient(redisConnection);
redisClient.connect().catch(err => {
  console.error('Redis connect error:', err);
  console.log('⚠️  Redis connection failed. Queue processing will not work without Redis.');
});

export async function addToQueue(order: Order) {
  console.log(`Adding order ${order.orderId} to queue`);
  await queue.add('processOrder', { order }, { 
    attempts: 3, 
    backoff: { type: 'exponential', delay: 1000 }
  });
}

// Initialize worker with proper error handling
let worker: Worker | null = null;

// Initialize worker unless we're in a test environment that explicitly disables it
if (process.env.NODE_ENV !== 'test' || process.env.ENABLE_WORKER === 'true') {
  console.log('🔧 Initializing worker...');
  try {
    worker = new Worker('processOrder', async (job) => {
    const { order } = job.data as { order: Order };
    const router = new MockDexRouter();
    
    console.log(`Processing order ${order.orderId} with status: ${order.status}`);

    try {
      // Step 1: Pending (already set)
      console.log(`Order ${order.orderId}: Status = pending`);
      await updateStatus(order);

      // Step 2: Routing - Get quotes from both DEXs
      order.status = 'routing';
      await updateStatus(order);
      console.log(`Order ${order.orderId}: Status = routing - Getting quotes from DEXs`);
      
      const routingResult = await router.selectBestDex(order.tokenIn, order.tokenOut, order.amount);
      order.selectedDex = routingResult.dex;
      order.routingDecision = routingResult.decision;
      
      console.log(`Order ${order.orderId}: Selected ${routingResult.dex} for execution`);

      // Step 3: Building transaction
      order.status = 'building';
      await updateStatus(order);
      console.log(`Order ${order.orderId}: Status = building - Creating transaction`);
      
      // Simulate transaction building time
      await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1000));

      // Step 4: Submitted to network
      order.status = 'submitted';
      await updateStatus(order);
      console.log(`Order ${order.orderId}: Status = submitted - Transaction sent to network`);

      // Step 5: Execute swap
      const result = await router.executeSwap(routingResult.dex, order);
      order.txHash = result.txHash;
      order.executedPrice = result.executedPrice;
      order.status = 'confirmed';
      await updateStatus(order);
      
      console.log(`Order ${order.orderId}: Status = confirmed - Transaction hash: ${result.txHash}`);
      
      // Database removed
      
    } catch (error: any) {
      console.error(`Order ${order.orderId} failed:`, error);
      order.status = 'failed';
      order.error = error.message || 'Unknown error occurred during execution';
      await updateStatus(order);
      // Database removed
      
      // Don't throw error to prevent job retry (we've already handled it)
      console.log(`Order ${order.orderId}: Status = failed - ${order.error}`);
    }
  }, { 
    connection: redisConnection, 
    concurrency: 10
  });

    // Handle worker events
    worker.on('completed', (job) => {
      console.log(`Job ${job.id} completed for order ${job.data.order.orderId}`);
    });

    worker.on('failed', (job, err) => {
      console.error(`Job ${job?.id} failed:`, err);
    });

    console.log('✅ Worker initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize worker:', error);
  }
}

async function updateStatus(order: Order) {
  try {
    // Store latest snapshot
    await redisClient.set(order.orderId, JSON.stringify(order));

    // Append to status history list for this order
    const historyEntry = {
      orderId: order.orderId,
      status: order.status,
      timestamp: new Date().toISOString(),
      selectedDex: order.selectedDex,
      txHash: order.txHash,
      executedPrice: order.executedPrice
    } as const;
    await redisClient.rPush(`history:${order.orderId}`, JSON.stringify(historyEntry));

    console.log(`Updated status for order ${order.orderId}: ${order.status}`);
  } catch (error) {
    console.error(`Failed to update status for order ${order.orderId}:`, error);
  }
}

// saveToDb removed