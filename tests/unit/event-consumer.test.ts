import type {
  DeadLetterRepository,
  InboxRepository,
} from '../../src/modules/events/events.repository';
import { EventConsumer, type EventHandlers } from '../../src/modules/events/event-consumer';
import type { MessageBus, ReceivedMessage } from '../../src/providers/message-bus';
import { fakeDbContext, mockOf } from './fakes';

const orderId = '11111111-1111-4111-8111-111111111111';

function message(type: string, deliveryCount = 1, payload: unknown = { orderId }): ReceivedMessage {
  return {
    event: {
      id: 'evt-1',
      type,
      aggregateId: orderId,
      payload,
      occurredAt: new Date().toISOString(),
    },
    deliveryCount,
    receipt: '1-0',
  };
}

describe('EventConsumer', () => {
  let bus: jest.Mocked<MessageBus>;
  let inbox: jest.Mocked<InboxRepository>;
  let deadLetters: jest.Mocked<DeadLetterRepository>;
  let handler: jest.Mock;
  let consumer: EventConsumer;

  beforeEach(() => {
    bus = mockOf<MessageBus>('receive', 'ack');
    inbox = mockOf<InboxRepository>('exists', 'add');
    deadLetters = mockOf<DeadLetterRepository>('create');
    inbox.exists.mockResolvedValue(false);
    handler = jest.fn().mockResolvedValue(undefined);
    const handlers: EventHandlers = { 'order.confirmed': handler };
    consumer = new EventConsumer('test', handlers, {
      db: fakeDbContext(),
      bus,
      inbox,
      deadLetters,
      maxAttempts: 3,
    });
  });

  it('handles a new event: records it in the inbox, runs the handler, then acks', async () => {
    const msg = message('order.confirmed');
    expect(await consumer.process(msg)).toBe('handled');
    expect(inbox.add).toHaveBeenCalledWith(expect.anything(), {
      consumer: 'test',
      eventId: 'evt-1',
      eventType: 'order.confirmed',
    });
    expect(handler).toHaveBeenCalledWith(expect.anything(), { orderId });
    expect(bus.ack).toHaveBeenCalledWith('test', msg);
  });

  it('acks a duplicate without running the handler', async () => {
    inbox.exists.mockResolvedValue(true);
    expect(await consumer.process(message('order.confirmed'))).toBe('duplicate');
    expect(handler).not.toHaveBeenCalled();
    expect(bus.ack).toHaveBeenCalled();
  });

  it('acks and skips event types this consumer does not handle', async () => {
    expect(await consumer.process(message('payment.charged'))).toBe('ignored');
    expect(inbox.exists).not.toHaveBeenCalled();
    expect(bus.ack).toHaveBeenCalled();
  });

  it('leaves a failed message un-acked for redelivery while attempts remain', async () => {
    handler.mockRejectedValue(new Error('boom'));
    expect(await consumer.process(message('order.confirmed', 2))).toBe('retry');
    expect(bus.ack).not.toHaveBeenCalled();
    expect(deadLetters.create).not.toHaveBeenCalled();
  });

  it('dead-letters and acks a message on its last allowed attempt', async () => {
    handler.mockRejectedValue(new Error('boom'));
    expect(await consumer.process(message('order.confirmed', 3))).toBe('dead-lettered');
    expect(deadLetters.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ consumer: 'test', eventId: 'evt-1', error: 'boom', attempts: 3 }),
    );
    expect(bus.ack).toHaveBeenCalled();
  });

  it('treats a payload that breaks the event contract as a failure', async () => {
    expect(await consumer.process(message('order.confirmed', 1, { orderId: 'not-a-uuid' }))).toBe(
      'retry',
    );
    expect(handler).not.toHaveBeenCalled();
  });
});
