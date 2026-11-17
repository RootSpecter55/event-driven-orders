import { Router, type RequestHandler } from 'express';
import { validate } from '../../common/validate';
import type { PaymentsController } from './payments.controller';
import { listPaymentsQuery } from './payments.schemas';

/** Mounted at /payments. Admin only. */
export function paymentsRoutes(
  controller: PaymentsController,
  requireAdmin: RequestHandler,
): Router {
  const router = Router();
  router.use(requireAdmin);
  router.get('/', validate({ query: listPaymentsQuery }), controller.list);
  return router;
}
