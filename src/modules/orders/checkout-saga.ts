import type { Db } from '../../common/db';
import { NotFoundError } from '../../common/errors';
import type { Order, OrderStatus } from '../../generated/prisma/client';
import type { EventHandlers } from '../events/event-consumer';
import type { OutboxRepository } from '../events/events.repository';
import { assertTransition, InvalidTransitionError, type FailureReason } from './order-status';
import type { OrderRepository } from './orders.repository';

export const ORDERS_CONSUMER = 'orders';

/**
 * Orchestrated saga for checkout: reserve stock -> charge -> confirm.
 *
 * The orders module is the orchestrator. It reacts to replies from inventory and payments and
 * sends the next command by appending it to the outbox, in the same transaction as the order's
 * status change. When a step fails, the steps already done are undone in reverse order:
 *
 *   reservation failed  -> cancel (nothing to undo)
 *   payment declined    -> release stock -> cancel
 *   commit failed       -> refund -> release stock -> cancel
 */
export class CheckoutSaga {
  constructor(
    private readonly orders: OrderRepository,
    private readonly outbox: OutboxRepository,
  ) {}

  async onStockReserved(tx: Db, orderId: string) {
    const order = await this.move(tx, orderId, 'STOCK_RESERVED');
    await this.outbox.append(tx, 'payment.charge-requested', orderId, {
      orderId,
      amountCents: order.totalCents,
      paymentToken: order.paymentToken,
    });
  }

  async onReservationFailed(tx: Db, orderId: string) {
    await this.move(tx, orderId, 'CANCELLED', 'OUT_OF_STOCK');
    await this.outbox.append(tx, 'order.cancelled', orderId, { orderId, reason: 'OUT_OF_STOCK' });
  }

  async onPaymentCharged(tx: Db, orderId: string) {
    await this.move(tx, orderId, 'PAID');
    await this.outbox.append(tx, 'inventory.commit-requested', orderId, { orderId });
  }

  async onPaymentDeclined(tx: Db, orderId: string) {
    await this.move(tx, orderId, 'COMPENSATING', 'PAYMENT_DECLINED');
    await this.outbox.append(tx, 'inventory.release-requested', orderId, { orderId });
  }

  async onStockCommitted(tx: Db, orderId: string) {
    await this.move(tx, orderId, 'CONFIRMED');
    await this.outbox.append(tx, 'order.confirmed', orderId, { orderId });
  }

  async onCommitFailed(tx: Db, orderId: string) {
    await this.move(tx, orderId, 'COMPENSATING', 'RESERVATION_EXPIRED');
    await this.outbox.append(tx, 'payment.refund-requested', orderId, { orderId });
  }

  /** Refund done: the next compensation in reverse order is releasing the stock. */
  async onPaymentRefunded(tx: Db, orderId: string) {
    const order = await this.load(tx, orderId);
    if (order.status !== 'COMPENSATING') {
      throw new InvalidTransitionError(order.status, 'COMPENSATING');
    }
    await this.outbox.append(tx, 'inventory.release-requested', orderId, { orderId });
  }

  /** Last compensation done. */
  async onStockReleased(tx: Db, orderId: string) {
    const order = await this.move(tx, orderId, 'CANCELLED');
    await this.outbox.append(tx, 'order.cancelled', orderId, {
      orderId,
      reason: order.failureReason ?? 'UNKNOWN',
    });
  }

  private async load(tx: Db, orderId: string): Promise<Order> {
    const order = await this.orders.findById(tx, orderId);
    if (!order) throw new NotFoundError('Order');
    return order;
  }

  private async move(tx: Db, orderId: string, to: OrderStatus, reason?: FailureReason) {
    const order = await this.load(tx, orderId);
    assertTransition(order.status, to);
    return this.orders.transition(tx, orderId, order.status, to, reason);
  }
}

/** The replies the orders consumer reacts to. */
export function checkoutSagaHandlers(saga: CheckoutSaga): EventHandlers {
  return {
    'inventory.stock-reserved': (tx, { orderId }) => saga.onStockReserved(tx, orderId),
    'inventory.reservation-failed': (tx, { orderId }) => saga.onReservationFailed(tx, orderId),
    'payment.charged': (tx, { orderId }) => saga.onPaymentCharged(tx, orderId),
    'payment.declined': (tx, { orderId }) => saga.onPaymentDeclined(tx, orderId),
    'inventory.stock-committed': (tx, { orderId }) => saga.onStockCommitted(tx, orderId),
    'inventory.commit-failed': (tx, { orderId }) => saga.onCommitFailed(tx, orderId),
    'payment.refunded': (tx, { orderId }) => saga.onPaymentRefunded(tx, orderId),
    'inventory.stock-released': (tx, { orderId }) => saga.onStockReleased(tx, orderId),
  };
}
