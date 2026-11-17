import { randomUUID } from 'node:crypto';
import type { ChargeRequest, ChargeResult, PaymentProvider } from './payment-provider';

/** Like a card processor's test cards: this token is always declined. */
export const DECLINED_TOKEN = 'tok_declined';

/**
 * Local stand-in for a card processor; no account or network needed. It declines DECLINED_TOKEN,
 * or every charge when `declineAll` is set (FAKE_PAYMENT_DECLINE=true). Like a real processor, it
 * honours idempotency keys, but only in memory, for the life of the process.
 */
export class FakePaymentProvider implements PaymentProvider {
  private readonly results = new Map<string, ChargeResult>();
  readonly refunds = new Map<string, string>();

  constructor(private readonly declineAll = false) {}

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const previous = this.results.get(request.idempotencyKey);
    if (previous) return previous;

    const result: ChargeResult =
      this.declineAll || request.paymentToken === DECLINED_TOKEN
        ? { status: 'declined', reason: 'card_declined' }
        : { status: 'succeeded', chargeId: `ch_fake_${randomUUID()}` };
    this.results.set(request.idempotencyKey, result);
    return result;
  }

  async refund(chargeId: string, idempotencyKey: string): Promise<void> {
    if (!this.refunds.has(idempotencyKey)) this.refunds.set(idempotencyKey, chargeId);
  }
}
