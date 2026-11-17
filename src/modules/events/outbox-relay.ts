import type { DbContext } from '../../common/db';
import type { OutboxEvent } from '../../generated/prisma/client';
import type { MessageBus } from '../../providers/message-bus';
import type { EventEnvelope } from './event-types';
import type { OutboxRepository } from './events.repository';

export function toEnvelope(row: OutboxEvent): EventEnvelope {
  return {
    id: row.eventId,
    type: row.type,
    aggregateId: row.aggregateId,
    payload: row.payload,
    occurredAt: row.createdAt.toISOString(),
  };
}

/**
 * Moves events from the outbox table to the message bus.
 *
 * Rows are locked, published, then marked published, all in one transaction. If the process
 * dies after publishing but before the commit, the rows stay unpublished and go out again on
 * the next run. Consumers therefore see duplicates, which the inbox absorbs.
 */
export class OutboxRelay {
  constructor(
    private readonly db: DbContext,
    private readonly outbox: OutboxRepository,
    private readonly bus: MessageBus,
    private readonly batchSize: number,
  ) {}

  /** Publishes one batch. Returns how many events were published. */
  runOnce(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const rows = await this.outbox.lockUnpublished(tx, this.batchSize);
      for (const row of rows) {
        await this.bus.publish(toEnvelope(row));
      }
      if (rows.length > 0) {
        await this.outbox.markPublished(
          tx,
          rows.map((row) => row.id),
          new Date(),
        );
      }
      return rows.length;
    });
  }
}
