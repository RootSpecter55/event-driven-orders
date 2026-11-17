import { hostname } from 'node:os';
import type { Redis } from 'ioredis';
import type { EventEnvelope } from '../../modules/events/event-types';
import type { MessageBus, ReceivedMessage } from './message-bus';

type StreamEntry = [id: string, fields: string[]];
type PendingEntry = [id: string, consumer: string, idleMs: number, deliveryCount: number];

/**
 * Local message bus: one Redis stream holds every event, and each consumer name is a consumer
 * group on it. Unacked entries stay in the group's pending list; once they have been idle for
 * `retryDelayMs` the next receive() claims them again, which raises their delivery count.
 */
export class RedisStreamsBus implements MessageBus {
  /** Blocking reads hold a connection, so each consumer reads on its own connection. */
  private readonly readers = new Map<string, Redis>();
  private readonly knownGroups = new Set<string>();

  constructor(
    private readonly redis: Redis,
    private readonly stream: string,
    private readonly retryDelayMs: number,
    private readonly workerId = `${hostname()}-${process.pid}`,
  ) {}

  async publish(event: EventEnvelope): Promise<void> {
    // Capped so the stream cannot grow forever; consumers ack long before 100k entries.
    await this.redis.xadd(this.stream, 'MAXLEN', '~', 100_000, '*', 'event', JSON.stringify(event));
  }

  async receive(consumer: string, { max, waitMs }: { max: number; waitMs: number }) {
    await this.ensureGroup(consumer);
    const retries = await this.claimDueRetries(consumer, max);
    if (retries.length > 0) return retries;

    const reader = this.reader(consumer);
    const group = ['GROUP', consumer, this.workerId, 'COUNT', max] as const;
    const result = (
      waitMs > 0
        ? await reader.xreadgroup(...group, 'BLOCK', waitMs, 'STREAMS', this.stream, '>')
        : await reader.xreadgroup(...group, 'STREAMS', this.stream, '>')
    ) as [stream: string, entries: StreamEntry[]][] | null;
    const entries = result?.[0]?.[1] ?? [];
    return entries.map((entry) => toMessage(entry, 1));
  }

  async ack(consumer: string, message: ReceivedMessage): Promise<void> {
    await this.redis.xack(this.stream, consumer, message.receipt);
  }

  async close(): Promise<void> {
    await Promise.all([...this.readers.values()].map((reader) => reader.quit()));
    this.readers.clear();
  }

  /** Takes over pending entries idle for at least retryDelayMs (failed or from a dead worker). */
  private async claimDueRetries(consumer: string, max: number): Promise<ReceivedMessage[]> {
    const pending = (await this.redis.xpending(
      this.stream,
      consumer,
      'IDLE',
      this.retryDelayMs,
      '-',
      '+',
      max,
    )) as PendingEntry[];
    if (pending.length === 0) return [];

    const claimed = (await this.redis.xclaim(
      this.stream,
      consumer,
      this.workerId,
      this.retryDelayMs,
      ...pending.map(([id]) => id),
    )) as StreamEntry[];
    // XCLAIM adds one delivery to the count XPENDING reported.
    const counts = new Map(pending.map(([id, , , count]) => [id, count + 1]));
    return claimed.map((entry) => toMessage(entry, counts.get(entry[0]) ?? 1));
  }

  private async ensureGroup(consumer: string): Promise<void> {
    if (this.knownGroups.has(consumer)) return;
    try {
      // Start at 0, not $, so events published before the worker first started are not skipped.
      await this.redis.xgroup('CREATE', this.stream, consumer, '0', 'MKSTREAM');
    } catch (err) {
      if (!(err as Error).message.includes('BUSYGROUP')) throw err;
    }
    this.knownGroups.add(consumer);
  }

  private reader(consumer: string): Redis {
    let reader = this.readers.get(consumer);
    if (!reader) {
      reader = this.redis.duplicate();
      this.readers.set(consumer, reader);
    }
    return reader;
  }
}

function toMessage([id, fields]: StreamEntry, deliveryCount: number): ReceivedMessage {
  // Entries are written only by publish() above: fields are ['event', <json>].
  const json = fields[fields.indexOf('event') + 1] ?? '{}';
  return { event: JSON.parse(json) as EventEnvelope, deliveryCount, receipt: id };
}
