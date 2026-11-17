import type { Express } from 'express';
import request from 'supertest';
import { getPrisma } from '../../src/common/db';
import { getRedis } from '../../src/common/redis';
import type { Container } from '../../src/container';

export const adminAuth = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

export async function resetState() {
  await getPrisma().$executeRawUnsafe(
    'TRUNCATE products, orders, order_items, stock_reservations, payments, outbox_events, inbox_entries, dead_letters CASCADE',
  );
  await getRedis().flushdb();
}

export async function closeShared() {
  await getPrisma().$disconnect();
  await getRedis().quit();
}

export type WorkerParts = ReturnType<Container['workerParts']>;

/**
 * Runs the relay and every consumer, round after round, until a whole round does no work.
 * At that point every saga has reached a final state. Deterministic: no timers, no sleeps.
 */
export async function settle(worker: WorkerParts, maxRounds = 50) {
  for (let round = 0; round < maxRounds; round++) {
    let work = await worker.relay.runOnce();
    for (const consumer of worker.consumers) work += await consumer.pollOnce(0);
    if (work === 0) return;
  }
  throw new Error(`Saga did not settle within ${maxRounds} rounds`);
}

export async function createProduct(app: Express, stock: number, sku = 'MUG-1', priceCents = 1200) {
  const res = await request(app)
    .post('/products')
    .set(adminAuth)
    .send({ sku, name: `Product ${sku}`, priceCents, stock })
    .expect(201);
  return res.body.data as { id: string; stock: number };
}

export function placeOrder(
  app: Express,
  productId: string,
  quantity = 1,
  paymentToken = 'tok_visa',
) {
  return request(app)
    .post('/orders')
    .send({ customerEmail: 'ada@example.com', paymentToken, items: [{ productId, quantity }] });
}

export async function stockOf(productId: string) {
  return (await getPrisma().product.findUniqueOrThrow({ where: { id: productId } })).stock;
}

export async function orderOf(orderId: string) {
  return getPrisma().order.findUniqueOrThrow({ where: { id: orderId } });
}
