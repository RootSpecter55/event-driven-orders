import type { Db, DbContext } from '../../common/db';
import { logger } from '../../common/logger';
import type { MessageBus, ReceivedMessage } from '../../providers/message-bus';
import { eventSchemas, isEventType, type EventPayload, type EventType } from './event-types';
import type { DeadLetterRepository, InboxRepository } from './events.repository';

/** The events one consumer reacts to, each with its handler. Anything else is acked and skipped. */
export type EventHandlers = {
  [T in EventType]?: (tx: Db, payload: EventPayload<T>) => Promise<void>;
};

export type ConsumeResult = 'handled' | 'duplicate' | 'ignored' | 'retry' | 'dead-lettered';

export type ConsumerDeps = {
  db: DbContext;
  bus: MessageBus;
  inbox: InboxRepository;
  deadLetters: DeadLetterRepository;
  maxAttempts: number;
};

/**
 * Runs one consumer: receives messages, handles each one exactly once, and dead-letters
 * messages that keep failing. The same runner is used by inventory, payments and orders.
 */
export class EventConsumer {
  constructor(
    readonly name: string,
    private readonly handlers: EventHandlers,
    private readonly deps: ConsumerDeps,
  ) {}

  /** Receives one batch and processes it. Returns the number of messages received. */
  async pollOnce(waitMs = 0): Promise<number> {
    const messages = await this.deps.bus.receive(this.name, { max: 10, waitMs });
    for (const message of messages) {
      await this.process(message);
    }
    return messages.length;
  }

  async process(message: ReceivedMessage): Promise<ConsumeResult> {
    const { db, bus, inbox } = this.deps;
    const { event } = message;
    const handler = isEventType(event.type) ? this.handlers[event.type] : undefined;

    if (!handler) {
      await bus.ack(this.name, message);
      return 'ignored';
    }
    if (await inbox.exists(db.client(), this.name, event.id)) {
      await bus.ack(this.name, message);
      return 'duplicate';
    }

    try {
      await db.transaction(async (tx) => {
        // Inbox row first: a concurrent copy of the same event blocks on the unique key and
        // then fails, rolling back its effects. Effects, inbox row and any events the handler
        // appends to the outbox all commit together.
        await inbox.add(tx, { consumer: this.name, eventId: event.id, eventType: event.type });
        const payload = eventSchemas[event.type as EventType].parse(event.payload);
        // The map's key matches event.type, so this handler accepts this payload.
        await (handler as (tx: Db, payload: unknown) => Promise<void>)(tx, payload);
      });
    } catch (err) {
      return this.handleFailure(message, err);
    }

    await bus.ack(this.name, message);
    return 'handled';
  }

  private async handleFailure(message: ReceivedMessage, err: unknown): Promise<ConsumeResult> {
    const { db, bus, deadLetters, maxAttempts } = this.deps;
    const { event } = message;
    const error = err instanceof Error ? err.message : String(err);

    if (message.deliveryCount < maxAttempts) {
      // Not acked: the broker delivers it again after the retry delay.
      logger.warn(
        {
          consumer: this.name,
          eventId: event.id,
          type: event.type,
          attempt: message.deliveryCount,
          error,
        },
        'Event handling failed, will retry',
      );
      return 'retry';
    }

    await deadLetters.create(db.client(), {
      consumer: this.name,
      eventId: event.id,
      eventType: event.type,
      aggregateId: event.aggregateId,
      payload: event.payload as object,
      error,
      attempts: message.deliveryCount,
    });
    await bus.ack(this.name, message);
    logger.error(
      { consumer: this.name, eventId: event.id, type: event.type, error },
      'Event moved to dead letters',
    );
    return 'dead-lettered';
  }
}
