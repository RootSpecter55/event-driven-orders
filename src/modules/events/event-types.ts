import { z } from 'zod';

/**
 * The event contract between modules. Every event the system publishes is listed here with a
 * schema for its payload. Commands ("...-requested") are sent by the checkout saga; the other
 * events are replies from inventory and payments, or notifications about the order.
 */
const orderId = z.uuid();
const orderRef = z.object({ orderId });
const failure = z.object({ orderId, reason: z.string().min(1) });

export const eventSchemas = {
  'inventory.reserve-requested': z.object({
    orderId,
    items: z.array(z.object({ productId: z.uuid(), quantity: z.number().int().positive() })).min(1),
  }),
  'inventory.stock-reserved': orderRef,
  'inventory.reservation-failed': failure,
  'inventory.commit-requested': orderRef,
  'inventory.stock-committed': orderRef,
  'inventory.commit-failed': failure,
  'inventory.release-requested': orderRef,
  'inventory.stock-released': orderRef,

  'payment.charge-requested': z.object({
    orderId,
    amountCents: z.number().int().positive(),
    paymentToken: z.string().min(1),
  }),
  'payment.charged': z.object({ orderId, paymentId: z.uuid() }),
  'payment.declined': failure,
  'payment.refund-requested': orderRef,
  'payment.refunded': orderRef,

  'order.confirmed': orderRef,
  'order.cancelled': failure,
} as const;

export type EventType = keyof typeof eventSchemas;
export type EventPayload<T extends EventType> = z.infer<(typeof eventSchemas)[T]>;

export function isEventType(type: string): type is EventType {
  return Object.hasOwn(eventSchemas, type);
}

/** What travels on the bus. `id` is the event id that consumers deduplicate on. */
export type EventEnvelope = {
  id: string;
  type: string;
  aggregateId: string;
  payload: unknown;
  occurredAt: string;
};
