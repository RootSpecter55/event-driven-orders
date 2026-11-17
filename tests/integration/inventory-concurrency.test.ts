import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/app';
import { dbContext, getPrisma } from '../../src/common/db';
import { buildContainer } from '../../src/container';
import { closeShared, createProduct, resetState, stockOf } from './helpers';

const container = buildContainer();
const app = createApp(container);

beforeEach(resetState);
afterAll(closeShared);

describe('stock reservation under concurrency', () => {
  it('ten concurrent reservations for the last unit: exactly one succeeds', async () => {
    const product = await createProduct(app, 1);

    // Each reservation runs in its own transaction on its own pooled connection, at the same time.
    await Promise.all(
      Array.from({ length: 10 }, () => {
        const orderId = randomUUID();
        return dbContext.transaction((tx) =>
          container.services.inventory.reserve(tx, {
            orderId,
            items: [{ productId: product.id, quantity: 1 }],
          }),
        );
      }),
    );

    expect(await stockOf(product.id)).toBe(0);
    expect(await getPrisma().stockReservation.count()).toBe(1);
    const replies = await getPrisma().outboxEvent.groupBy({ by: ['type'], _count: true });
    expect(Object.fromEntries(replies.map((r) => [r.type, r._count]))).toEqual({
      'inventory.stock-reserved': 1,
      'inventory.reservation-failed': 9,
    });
  });

  it('a multi-item order that cannot be fully reserved takes nothing', async () => {
    const plenty = await createProduct(app, 10, 'PLENTY');
    const scarce = await createProduct(app, 1, 'SCARCE');

    await dbContext.transaction((tx) =>
      container.services.inventory.reserve(tx, {
        orderId: randomUUID(),
        items: [
          { productId: plenty.id, quantity: 3 },
          { productId: scarce.id, quantity: 2 },
        ],
      }),
    );

    expect(await stockOf(plenty.id)).toBe(10);
    expect(await stockOf(scarce.id)).toBe(1);
    expect(await getPrisma().stockReservation.count()).toBe(0);
  });
});
