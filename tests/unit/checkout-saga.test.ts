import type { Db } from '../../src/common/db';
import type { Order, OrderStatus } from '../../src/generated/prisma/client';
import type { OutboxRepository } from '../../src/modules/events/events.repository';
import { CheckoutSaga } from '../../src/modules/orders/checkout-saga';
import { InvalidTransitionError } from '../../src/modules/orders/order-status';
import type { OrderRepository } from '../../src/modules/orders/orders.repository';
import { mockOf } from './fakes';

const tx = {} as Db;
const orderId = '11111111-1111-4111-8111-111111111111';

function order(status: OrderStatus, overrides: Partial<Order> = {}): Order {
  return {
    id: orderId,
    customerEmail: 'ada@example.com',
    status,
    totalCents: 2400,
    paymentToken: 'tok_visa',
    failureReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('CheckoutSaga', () => {
  let orders: jest.Mocked<OrderRepository>;
  let outbox: jest.Mocked<OutboxRepository>;
  let saga: CheckoutSaga;

  /** The order is loaded in `from`; the transition returns it in its new status. */
  function given(from: OrderStatus, overrides: Partial<Order> = {}) {
    orders.findById.mockResolvedValue(order(from, overrides));
    orders.transition.mockImplementation(async (_db, _id, _from, to, reason) =>
      order(to, { ...overrides, ...(reason ? { failureReason: reason } : {}) }),
    );
  }

  function sentEvents() {
    return outbox.append.mock.calls.map(([, type, , payload]) => ({ type, payload }));
  }

  beforeEach(() => {
    orders = mockOf<OrderRepository>('findById', 'transition');
    outbox = mockOf<OutboxRepository>('append');
    saga = new CheckoutSaga(orders, outbox);
  });

  it('stock reserved: moves to STOCK_RESERVED and requests the charge for the order total', async () => {
    given('PENDING');
    await saga.onStockReserved(tx, orderId);
    expect(orders.transition).toHaveBeenCalledWith(
      tx,
      orderId,
      'PENDING',
      'STOCK_RESERVED',
      undefined,
    );
    expect(sentEvents()).toEqual([
      {
        type: 'payment.charge-requested',
        payload: { orderId, amountCents: 2400, paymentToken: 'tok_visa' },
      },
    ]);
  });

  it('reservation failed: cancels straight away, there is nothing to undo', async () => {
    given('PENDING');
    await saga.onReservationFailed(tx, orderId);
    expect(orders.transition).toHaveBeenCalledWith(
      tx,
      orderId,
      'PENDING',
      'CANCELLED',
      'OUT_OF_STOCK',
    );
    expect(sentEvents()).toEqual([
      { type: 'order.cancelled', payload: { orderId, reason: 'OUT_OF_STOCK' } },
    ]);
  });

  it('payment declined: compensates by releasing the stock', async () => {
    given('STOCK_RESERVED');
    await saga.onPaymentDeclined(tx, orderId);
    expect(orders.transition).toHaveBeenCalledWith(
      tx,
      orderId,
      'STOCK_RESERVED',
      'COMPENSATING',
      'PAYMENT_DECLINED',
    );
    expect(sentEvents()).toEqual([{ type: 'inventory.release-requested', payload: { orderId } }]);
  });

  it('commit failed after payment: refunds first, then releases once the refund is done', async () => {
    given('PAID');
    await saga.onCommitFailed(tx, orderId);
    expect(sentEvents()).toEqual([{ type: 'payment.refund-requested', payload: { orderId } }]);

    outbox.append.mockClear();
    given('COMPENSATING');
    await saga.onPaymentRefunded(tx, orderId);
    expect(sentEvents()).toEqual([{ type: 'inventory.release-requested', payload: { orderId } }]);
  });

  it('stock released: cancels with the reason recorded when compensation started', async () => {
    given('COMPENSATING', { failureReason: 'PAYMENT_DECLINED' });
    await saga.onStockReleased(tx, orderId);
    expect(sentEvents()).toEqual([
      { type: 'order.cancelled', payload: { orderId, reason: 'PAYMENT_DECLINED' } },
    ]);
  });

  it('rejects a reply that does not fit the current state, and sends nothing', async () => {
    given('CONFIRMED');
    await expect(saga.onStockReserved(tx, orderId)).rejects.toBeInstanceOf(InvalidTransitionError);
    given('PAID');
    await expect(saga.onPaymentRefunded(tx, orderId)).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
    expect(outbox.append).not.toHaveBeenCalled();
  });
});
