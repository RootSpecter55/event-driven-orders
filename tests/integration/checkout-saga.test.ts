import request from 'supertest';
import { createApp } from '../../src/app';
import { getPrisma } from '../../src/common/db';
import { buildContainer } from '../../src/container';
import {
  adminAuth,
  closeShared,
  createProduct,
  orderOf,
  placeOrder,
  resetState,
  settle,
  stockOf,
  type WorkerParts,
} from './helpers';

const container = buildContainer();
const app = createApp(container);
let worker: WorkerParts;

beforeAll(() => {
  worker = container.workerParts();
});
beforeEach(resetState);
afterAll(async () => {
  await worker.bus.close();
  await closeShared();
});

describe('checkout saga', () => {
  it('reserves, charges and confirms an order, publishing every event', async () => {
    const product = await createProduct(app, 5);
    const placed = await placeOrder(app, product.id, 2).expect(202);
    expect(placed.body.data).toMatchObject({ status: 'PENDING', totalCents: 2400 });
    expect(placed.body.data).not.toHaveProperty('paymentToken');

    await settle(worker);

    const order = await request(app).get(`/orders/${placed.body.data.id}`).expect(200);
    expect(order.body.data.status).toBe('CONFIRMED');
    expect(await stockOf(product.id)).toBe(3);

    const payments = await request(app).get('/payments').set(adminAuth).expect(200);
    expect(payments.body.data).toMatchObject([{ status: 'CHARGED', amountCents: 2400 }]);
    const reservations = await request(app).get('/inventory/reservations').set(adminAuth);
    expect(reservations.body.data).toMatchObject([{ status: 'COMMITTED', quantity: 2 }]);

    const outbox = await getPrisma().outboxEvent.findMany({ orderBy: { createdAt: 'asc' } });
    expect(outbox.map((e) => e.type)).toEqual([
      'inventory.reserve-requested',
      'inventory.stock-reserved',
      'payment.charge-requested',
      'payment.charged',
      'inventory.commit-requested',
      'inventory.stock-committed',
      'order.confirmed',
    ]);
    expect(outbox.every((e) => e.publishedAt !== null)).toBe(true);
  });

  it('releases the reserved stock when the payment is declined', async () => {
    const product = await createProduct(app, 5);
    const placed = await placeOrder(app, product.id, 2, 'tok_declined').expect(202);

    await settle(worker);

    const order = await orderOf(placed.body.data.id);
    expect(order).toMatchObject({ status: 'CANCELLED', failureReason: 'PAYMENT_DECLINED' });
    expect(await stockOf(product.id)).toBe(5);
    const reservation = await getPrisma().stockReservation.findFirstOrThrow();
    expect(reservation.status).toBe('RELEASED');
    const payment = await getPrisma().payment.findFirstOrThrow();
    expect(payment).toMatchObject({ status: 'DECLINED', declineReason: 'card_declined' });
  });

  it('refunds and releases when the reservation expired before the payment finished', async () => {
    // A zero TTL means the hold has always expired by the time inventory tries to commit it.
    const expiring = buildContainer({ config: { RESERVATION_TTL_SECONDS: 0 } });
    const expiringWorker = expiring.workerParts();
    const product = await createProduct(app, 5);
    const placed = await placeOrder(app, product.id, 1).expect(202);

    await settle(expiringWorker);
    await expiringWorker.bus.close();

    const order = await orderOf(placed.body.data.id);
    expect(order).toMatchObject({ status: 'CANCELLED', failureReason: 'RESERVATION_EXPIRED' });
    expect((await getPrisma().payment.findFirstOrThrow()).status).toBe('REFUNDED');
    expect((await getPrisma().stockReservation.findFirstOrThrow()).status).toBe('RELEASED');
    expect(await stockOf(product.id)).toBe(5);

    // Compensations ran in reverse order: refund first, then release.
    const types = (await getPrisma().outboxEvent.findMany({ orderBy: { createdAt: 'asc' } })).map(
      (e) => e.type,
    );
    expect(types.indexOf('payment.refunded')).toBeLessThan(
      types.indexOf('inventory.stock-released'),
    );
  });

  it('never oversells: five concurrent orders for the last item confirm exactly one', async () => {
    const product = await createProduct(app, 1);
    const placed = await Promise.all(
      Array.from({ length: 5 }, () => placeOrder(app, product.id, 1).expect(202)),
    );

    await settle(worker);

    const statuses = await Promise.all(placed.map((res) => orderOf(res.body.data.id)));
    expect(statuses.filter((o) => o.status === 'CONFIRMED')).toHaveLength(1);
    const cancelled = statuses.filter((o) => o.status === 'CANCELLED');
    expect(cancelled).toHaveLength(4);
    expect(cancelled.every((o) => o.failureReason === 'OUT_OF_STOCK')).toBe(true);
    expect(await stockOf(product.id)).toBe(0);
  });

  it('rejects unknown products and invalid order bodies', async () => {
    const unknown = await placeOrder(app, '00000000-0000-4000-8000-000000000000');
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('UNKNOWN_PRODUCT');

    const product = await createProduct(app, 5);
    const duplicate = await request(app)
      .post('/orders')
      .send({
        customerEmail: 'ada@example.com',
        paymentToken: 'tok_visa',
        items: [
          { productId: product.id, quantity: 1 },
          { productId: product.id, quantity: 2 },
        ],
      });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('lists orders with pagination and a status filter', async () => {
    const product = await createProduct(app, 5);
    await placeOrder(app, product.id).expect(202);
    await placeOrder(app, product.id, 1, 'tok_declined').expect(202);
    await settle(worker);

    const all = await request(app).get('/orders?pageSize=1').expect(200);
    expect(all.body.meta).toEqual({ page: 1, pageSize: 1, total: 2, totalPages: 2 });
    const cancelled = await request(app).get('/orders?status=CANCELLED').expect(200);
    expect(cancelled.body.data).toHaveLength(1);
  });
});
