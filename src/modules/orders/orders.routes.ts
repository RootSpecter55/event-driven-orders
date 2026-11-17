import { Router } from 'express';
import { validate } from '../../common/validate';
import type { OrdersController } from './orders.controller';
import { listOrdersQuery, orderParams, placeOrderBody } from './orders.schemas';

/** Mounted at /orders. There are no customer accounts in this project, so these are public. */
export function ordersRoutes(controller: OrdersController): Router {
  const router = Router();
  router.post('/', validate({ body: placeOrderBody }), controller.place);
  router.get('/', validate({ query: listOrdersQuery }), controller.list);
  router.get('/:orderId', validate({ params: orderParams }), controller.get);
  return router;
}
