import type { EventHandlers } from '../events/event-consumer';
import type { PaymentsService } from './payments.service';

export const PAYMENTS_CONSUMER = 'payments';

/** The commands the payments consumer reacts to. */
export function paymentsHandlers(service: PaymentsService): EventHandlers {
  return {
    'payment.charge-requested': (tx, payload) => service.charge(tx, payload),
    'payment.refund-requested': (tx, { orderId }) => service.refund(tx, orderId),
  };
}
