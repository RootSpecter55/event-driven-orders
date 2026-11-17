import type { EventEnvelope } from '../../modules/events/event-types';

export type ReceivedMessage = {
  event: EventEnvelope;
  /**
   * 1 on the first delivery, then one more for every redelivery. Both brokers track this:
   * Redis Streams in the pending entries list, SQS as ApproximateReceiveCount.
   */
  deliveryCount: number;
  /** Broker-specific handle used to ack this delivery (stream entry id / SQS receipt handle). */
  receipt: string;
};

/**
 * Publish/subscribe with consumer groups: every consumer name receives every published event,
 * and within one consumer name each message goes to one worker. A message that is not acked
 * is delivered again later, so delivery is at-least-once.
 */
export interface MessageBus {
  publish(event: EventEnvelope): Promise<void>;
  /** Up to `max` messages for `consumer`: redeliveries that are due first, then new ones. */
  receive(consumer: string, options: { max: number; waitMs: number }): Promise<ReceivedMessage[]>;
  ack(consumer: string, message: ReceivedMessage): Promise<void>;
  close(): Promise<void>;
}
