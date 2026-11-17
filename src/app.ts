import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import { errorHandler, notFoundHandler } from './common/error-handler';
import { logger } from './common/logger';
import { sendData } from './common/response';
import { buildContainer, type Container } from './container';
import { eventsRoutes } from './modules/events/events.routes';
import { inventoryRoutes } from './modules/inventory/inventory.routes';
import { ordersRoutes } from './modules/orders/orders.routes';
import { paymentsRoutes } from './modules/payments/payments.routes';
import { productsRoutes } from './modules/products/products.routes';

export function createApp(container: Container = buildContainer()): Express {
  const { controllers: c, requireAdmin } = container;
  const app = express();
  app.disable('x-powered-by');
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_req, res) => sendData(res, { status: 'ok' }));

  app.use('/products', productsRoutes(c.products, requireAdmin));
  app.use('/orders', ordersRoutes(c.orders));
  app.use('/inventory', inventoryRoutes(c.inventory, requireAdmin));
  app.use('/payments', paymentsRoutes(c.payments, requireAdmin));
  app.use('/events', eventsRoutes(c.events, requireAdmin));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
