import type { Db, DbContext } from '../../common/db';
import { ConflictError } from '../../common/errors';
import { toPage, toSkipTake } from '../../common/pagination';
import type { PaymentProvider } from '../../providers/payment/payment-provider';
import type { EventPayload } from '../events/event-types';
import type { OutboxRepository } from '../events/events.repository';
import type { PaymentRepository } from './payments.repository';
import type { ListPaymentsQuery } from './payments.schemas';

/**
 * Handles the saga's payment commands. The provider call happens inside the consumer's
 * transaction, so if that transaction later rolls back the message is retried. The idempotency
 * key (derived from the order id) makes the retry return the original charge, not a second one.
 */
export class PaymentsService {
  constructor(
    private readonly db: DbContext,
    private readonly payments: PaymentRepository,
    private readonly outbox: OutboxRepository,
    private readonly provider: PaymentProvider,
  ) {}

  async charge(
    tx: Db,
    { orderId, amountCents, paymentToken }: EventPayload<'payment.charge-requested'>,
  ) {
    const result = await this.provider.charge({
      idempotencyKey: `charge-${orderId}`,
      amountCents,
      paymentToken,
    });

    if (result.status === 'declined') {
      await this.payments.create(tx, {
        orderId,
        amountCents,
        status: 'DECLINED',
        declineReason: result.reason,
      });
      await this.outbox.append(tx, 'payment.declined', orderId, { orderId, reason: result.reason });
      return;
    }

    const payment = await this.payments.create(tx, {
      orderId,
      amountCents,
      status: 'CHARGED',
      providerChargeId: result.chargeId,
    });
    await this.outbox.append(tx, 'payment.charged', orderId, { orderId, paymentId: payment.id });
  }

  /** Compensation for charge(). */
  async refund(tx: Db, orderId: string) {
    const payment = await this.payments.findByOrder(tx, orderId);
    if (payment?.status !== 'CHARGED' || !payment.providerChargeId) {
      throw new ConflictError(`Order ${orderId} has no charged payment to refund`);
    }
    await this.provider.refund(payment.providerChargeId, `refund-${orderId}`);
    await this.payments.update(tx, payment.id, { status: 'REFUNDED' });
    await this.outbox.append(tx, 'payment.refunded', orderId, { orderId });
  }

  async list(query: ListPaymentsQuery) {
    const { items, total } = await this.payments.list(this.db.client(), {
      where: query.orderId ? { orderId: query.orderId } : {},
      ...toSkipTake(query),
      orderBy: { createdAt: 'desc' },
    });
    return toPage(items, total, query);
  }
}
