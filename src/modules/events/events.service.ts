import type { DbContext } from '../../common/db';
import { ConflictError, NotFoundError } from '../../common/errors';
import { toPage, toSkipTake } from '../../common/pagination';
import type { DeadLetterRepository, OutboxRepository } from './events.repository';
import type { ListDeadLettersQuery, ListOutboxQuery } from './events.schemas';

export class EventsService {
  constructor(
    private readonly db: DbContext,
    private readonly outbox: OutboxRepository,
    private readonly deadLetters: DeadLetterRepository,
  ) {}

  async listOutbox(query: ListOutboxQuery) {
    const where =
      query.published === undefined
        ? {}
        : { publishedAt: query.published === 'true' ? { not: null } : null };
    const { items, total } = await this.outbox.list(this.db.client(), {
      where,
      ...toSkipTake(query),
      orderBy: { createdAt: 'desc' },
    });
    return toPage(items, total, query);
  }

  async listDeadLetters(query: ListDeadLettersQuery) {
    const { items, total } = await this.deadLetters.list(this.db.client(), {
      where: query.consumer ? { consumer: query.consumer } : {},
      ...toSkipTake(query),
      orderBy: { createdAt: 'desc' },
    });
    return toPage(items, total, query);
  }

  /**
   * Publishes a dead-lettered event again, through the outbox and under its original event id.
   * Every consumer receives it; the ones that already handled it skip it via their inbox.
   */
  redrive(deadLetterId: string) {
    return this.db.transaction(async (tx) => {
      const deadLetter = await this.deadLetters.findById(tx, deadLetterId);
      if (!deadLetter) throw new NotFoundError('Dead letter');
      if (deadLetter.redrivenAt) throw new ConflictError('Dead letter has already been redriven');

      await this.outbox.requeue(tx, deadLetter);
      return this.deadLetters.update(tx, deadLetter.id, { redrivenAt: new Date() });
    });
  }
}
