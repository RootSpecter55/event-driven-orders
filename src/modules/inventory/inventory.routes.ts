import { Router, type RequestHandler } from 'express';
import { validate } from '../../common/validate';
import type { InventoryController } from './inventory.controller';
import { listReservationsQuery } from './inventory.schemas';

/** Mounted at /inventory. Admin only. */
export function inventoryRoutes(
  controller: InventoryController,
  requireAdmin: RequestHandler,
): Router {
  const router = Router();
  router.use(requireAdmin);
  router.get(
    '/reservations',
    validate({ query: listReservationsQuery }),
    controller.listReservations,
  );
  return router;
}
