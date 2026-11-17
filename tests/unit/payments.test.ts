import type { Db } from '../../src/common/db';
import { ConflictError } from '../../src/common/errors';
import type { Payment } from '../../src/generated/prisma/client';
import type { OutboxRepository } from '../../src/modules/events/events.repository';
import type { PaymentRepository } from '../../src/modules/payments/payments.repository';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { DECLINED_TOKEN, FakePaymentProvider } from '../../src/providers/payment/fake.provider';
import { fakeDbContext, mockOf } from './fakes';

const tx = {} as Db;
const orderId = '11111111-1111-4111-8111-111111111111';

describe('FakePaymentProvider', () => {
  it('approves normal tokens and declines the test decline token', async () => {
    const provider = new FakePaymentProvider();
    const ok = await provider.charge({
      idempotencyKey: 'k1',
      amountCents: 100,
      paymentToken: 'tok_visa',
    });
    expect(ok).toMatchObject({ status: 'succeeded', chargeId: expect.stringMatching(/^ch_fake_/) });
    const declined = await provider.charge({
      idempotencyKey: 'k2',
      amountCents: 100,
      paymentToken: DECLINED_TOKEN,
    });
    expect(declined).toEqual({ status: 'declined', reason: 'card_declined' });
  });

  it('declines everything when configured to', async () => {
    const provider = new FakePaymentProvider(true);
    const result = await provider.charge({
      idempotencyKey: 'k',
      amountCents: 100,
      paymentToken: 'tok_visa',
    });
    expect(result.status).toBe('declined');
  });

  it('returns the first result for a repeated idempotency key instead of charging again', async () => {
    const provider = new FakePaymentProvider();
    const first = await provider.charge({
      idempotencyKey: 'same',
      amountCents: 100,
      paymentToken: 'tok_visa',
    });
    const second = await provider.charge({
      idempotencyKey: 'same',
      amountCents: 100,
      paymentToken: 'tok_visa',
    });
    expect(second).toEqual(first);
  });
});

describe('PaymentsService', () => {
  let payments: jest.Mocked<PaymentRepository>;
  let outbox: jest.Mocked<OutboxRepository>;
  let service: PaymentsService;

  beforeEach(() => {
    payments = mockOf<PaymentRepository>('create', 'findByOrder', 'update');
    outbox = mockOf<OutboxRepository>('append');
    service = new PaymentsService(fakeDbContext(), payments, outbox, new FakePaymentProvider());
  });

  it('records a declined charge and replies payment.declined', async () => {
    await service.charge(tx, { orderId, amountCents: 500, paymentToken: DECLINED_TOKEN });
    expect(payments.create).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ status: 'DECLINED' }),
    );
    expect(outbox.append).toHaveBeenCalledWith(tx, 'payment.declined', orderId, {
      orderId,
      reason: 'card_declined',
    });
  });

  it('refuses to refund an order that was never charged', async () => {
    payments.findByOrder.mockResolvedValue({ status: 'DECLINED' } as Payment);
    await expect(service.refund(tx, orderId)).rejects.toBeInstanceOf(ConflictError);
    expect(outbox.append).not.toHaveBeenCalled();
  });
});
