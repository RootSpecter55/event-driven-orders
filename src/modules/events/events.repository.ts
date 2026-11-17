import { randomUUID } from 'node:crypto';
import { BaseRepository } from '../../common/base-repository';
import type { Db } from '../../common/db';
import type { DeadLetter, OutboxEvent, Prisma } from '../../generated/prisma/client';
import { eventSchemas, type EventPayload, type EventType } from './event-types';

export class OutboxRepository extends BaseRepository<
  OutboxEvent,
  Prisma.OutboxEventUncheckedCreateInput,
  Prisma.OutboxEventUncheckedUpdateInput,
  Prisma.OutboxEventWhereInput
> {
  protected delegate(db: Db) {
    return db.outboxEvent;
  }

  /**
   * Records an event to publish. Must be called with the same transaction as the state change,
   * so the event exists if and only if the change committed. The payload is checked here so a
   * malformed event fails at its source, not in a consumer.
   */
  append<T extends EventType>(db: Db, type: T, aggregateId: string, payload: EventPayload<T>) {
    return db.outboxEvent.create({
      data: {
        eventId: randomUUID(),
        type,
        aggregateId,
        payload: eventSchemas[type].parse(payload) as Prisma.InputJsonValue,
      },
    });
  }

  /** Re-queues an existing event under its original id (used by dead-letter redrive). */
  requeue(db: Db, event: Pick<DeadLetter, 'eventId' | 'eventType' | 'aggregateId' | 'payload'>) {
    return db.outboxEvent.create({
      data: {
        eventId: event.eventId,
        type: event.eventType,
        aggregateId: event.aggregateId,
        payload: event.payload as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Locks the oldest unpublished rows for this transaction. SKIP LOCKED lets a second relay take
   * the next batch instead of waiting, so relays never publish the same row concurrently.
   */
  async lockUnpublished(db: Db, limit: number): Promise<OutboxEvent[]> {
    const locked = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM outbox_events
      WHERE published_at IS NULL
      ORDER BY created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED`;
    if (locked.length === 0) return [];
    return db.outboxEvent.findMany({
      where: { id: { in: locked.map((row) => row.id) } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async markPublished(db: Db, ids: string[], at: Date): Promise<void> {
    await db.outboxEvent.updateMany({ where: { id: { in: ids } }, data: { publishedAt: at } });
  }
}

export class InboxRepository {
  async exists(db: Db, consumer: string, eventId: string): Promise<boolean> {
    const row = await db.inboxEntry.findUnique({
      where: { consumer_eventId: { consumer, eventId } },
    });
    return row !== null;
  }

  async add(db: Db, entry: { consumer: string; eventId: string; eventType: string }) {
    await db.inboxEntry.create({ data: entry });
  }
}

export class DeadLetterRepository extends BaseRepository<
  DeadLetter,
  Prisma.DeadLetterUncheckedCreateInput,
  Prisma.DeadLetterUncheckedUpdateInput,
  Prisma.DeadLetterWhereInput
> {
  protected delegate(db: Db) {
    return db.deadLetter;
  }
}
