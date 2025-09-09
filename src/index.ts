import fastify from 'fastify';
import websocket from '@fastify/websocket';
import orderController from './controllers/orderController';
import * as dotenv from 'dotenv';

dotenv.config();

const app = fastify({ logger: true });
app.register(websocket);
app.register(orderController);

const start = async () => {
  try {
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`Server running on http://localhost:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();