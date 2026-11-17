import { Router, type RequestHandler } from 'express';
import { validate } from '../../common/validate';
import type { EventsController } from './events.controller';
import { deadLetterParams, listDeadLettersQuery, listOutboxQuery } from './events.schemas';

/** Mounted at /events. Admin only. */
export function eventsRoutes(controller: EventsController, requireAdmin: RequestHandler): Router {
  const router = Router();
  router.use(requireAdmin);
  router.get('/outbox', validate({ query: listOutboxQuery }), controller.listOutbox);
  router.get(
    '/dead-letters',
    validate({ query: listDeadLettersQuery }),
    controller.listDeadLetters,
  );
  router.post(
    '/dead-letters/:deadLetterId/redrive',
    validate({ params: deadLetterParams }),
    controller.redrive,
  );
  return router;
}
