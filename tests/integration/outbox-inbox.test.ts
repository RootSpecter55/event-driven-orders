import { createApp } from '../../src/app';
import { dbContext, getPrisma } from '../../src/common/db';
import { getRedis } from '../../src/common/redis';
import { buildContainer } from '../../src/container';
import { OutboxRepository } from '../../src/modules/events/events.repository';
import { OutboxRelay } from '../../src/modules/events/outbox-relay';
import {
  closeShared,
  createProduct,
  orderOf,
  placeOrder,
  resetState,
  settle,
  stockOf,
  type WorkerParts,
} from './helpers';

/** Publishes fine, then "crashes" before the published mark is committed. */
class CrashBeforeMarkOutbox extends OutboxRepository {
  override async markPublished(): Promise<void> {
    throw new Error('simulated crash after publishing');
  }
}

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

async function streamCopiesOf(eventId: string) {
  const entries = await getRedis().xrange(process.env.EVENTS_STREAM!, '-', '+');
  return entries.filter(([, fields]) => JSON.parse(fields[1]!).id === eventId).length;
}

describe('outbox relay and inbox', () => {
  it('a relay crash after publishing causes a duplicate that the inbox ignores', async () => {
    const product = await createProduct(app, 5);
    const placed = await placeOrder(app, product.id, 2).expect(202);
    const [row] = await getPrisma().outboxEvent.findMany();
    const eventId = row!.eventId;

    // 1. The relay publishes, then dies before marking the row published: the commit is lost.
    const crashing = new OutboxRelay(dbContext, new CrashBeforeMarkOutbox(), worker.bus, 100);
    await expect(crashing.runOnce()).rejects.toThrow('simulated crash');
    expect((await getPrisma().outboxEvent.findFirstOrThrow()).publishedAt).toBeNull();

    // 2. The next relay run publishes the same row again.
    expect(await worker.relay.runOnce()).toBe(1);
    expect(await streamCopiesOf(eventId)).toBe(2);

    // 3. Inventory receives both copies but reserves only once.
    const inventory = worker.consumers.find((c) => c.name === 'inventory')!;
    expect(await inventory.pollOnce(0)).toBe(2);

    const inbox = await getPrisma().inboxEntry.findMany({
      where: { consumer: 'inventory', eventId },
    });
    expect(inbox).toHaveLength(1);
    expect(await getPrisma().stockReservation.count()).toBe(1);
    expect(await stockOf(product.id)).toBe(3);

    // 4. The saga still completes normally.
    await settle(worker);
    expect((await orderOf(placed.body.data.id)).status).toBe('CONFIRMED');
    expect(await stockOf(product.id)).toBe(3);
  });

  it('marks published rows so a second relay run publishes nothing', async () => {
    const product = await createProduct(app, 5);
    await placeOrder(app, product.id).expect(202);

    expect(await worker.relay.runOnce()).toBe(1);
    expect(await worker.relay.runOnce()).toBe(0);
  });
});
