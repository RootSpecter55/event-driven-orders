import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app';
import { getPrisma } from '../../src/common/db';
import { getRedis } from '../../src/common/redis';
import { buildContainer } from '../../src/container';
import { EventConsumer } from '../../src/modules/events/event-consumer';
import { adminAuth, closeShared, resetState, type WorkerParts } from './helpers';

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

describe('dead letters and redrive', () => {
  it('dead-letters a message after MAX_DELIVERY_ATTEMPTS failures and redrives it', async () => {
    let broken = true;
    const handled: string[] = [];
    const flaky = new EventConsumer(
      'flaky',
      {
        'order.confirmed': async (_tx, { orderId }) => {
          if (broken) throw new Error('downstream unavailable');
          handled.push(orderId);
        },
      },
      worker.consumerDeps,
    );

    const orderId = randomUUID();
    await container.repos.outbox.append(getPrisma(), 'order.confirmed', orderId, { orderId });
    await worker.relay.runOnce();

    // MAX_DELIVERY_ATTEMPTS is 3 in tests; RETRY_DELAY_MS is 0, so each poll redelivers.
    for (let attempt = 0; attempt < 3; attempt++) await flaky.pollOnce(0);

    const list = await request(app).get('/events/dead-letters').set(adminAuth).expect(200);
    expect(list.body.data).toHaveLength(1);
    const deadLetter = list.body.data[0];
    expect(deadLetter).toMatchObject({
      consumer: 'flaky',
      eventType: 'order.confirmed',
      attempts: 3,
      error: 'downstream unavailable',
      redrivenAt: null,
    });
    // Acked after dead-lettering, so the broker stops redelivering it.
    const pending = await getRedis().xpending(process.env.EVENTS_STREAM!, 'flaky');
    expect(pending[0]).toBe(0);
    expect(await flaky.pollOnce(0)).toBe(0);

    // Fix the cause, then redrive: the same event id goes out again through the outbox.
    broken = false;
    await request(app)
      .post(`/events/dead-letters/${deadLetter.id}/redrive`)
      .set(adminAuth)
      .expect(202);
    await request(app)
      .post(`/events/dead-letters/${deadLetter.id}/redrive`)
      .set(adminAuth)
      .expect(409);

    await worker.relay.runOnce();
    await flaky.pollOnce(0);
    expect(handled).toEqual([orderId]);
    const inbox = await getPrisma().inboxEntry.findMany({ where: { consumer: 'flaky' } });
    expect(inbox).toMatchObject([{ eventId: deadLetter.eventId }]);
  });

  it('requires the admin key', async () => {
    await request(app).get('/events/dead-letters').expect(401);
    await request(app)
      .get('/events/dead-letters')
      .set({ Authorization: 'Bearer wrong-key' })
      .expect(401);
  });

  it('lists the outbox filtered by published state', async () => {
    const orderId = randomUUID();
    await container.repos.outbox.append(getPrisma(), 'order.confirmed', orderId, { orderId });

    const pending = await request(app).get('/events/outbox?published=false').set(adminAuth);
    expect(pending.body.meta.total).toBe(1);
    await worker.relay.runOnce();
    const published = await request(app).get('/events/outbox?published=true').set(adminAuth);
    expect(published.body.meta.total).toBe(1);
  });
});
