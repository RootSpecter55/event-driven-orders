import { PublishCommand, type SNSClient } from '@aws-sdk/client-sns';
import { DeleteMessageCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventEnvelope } from '../../modules/events/event-types';
import type { MessageBus, ReceivedMessage } from './message-bus';

/**
 * AWS message bus: events are published to one SNS topic, and each consumer name has its own
 * SQS queue subscribed to that topic with raw message delivery enabled. A message that is not
 * deleted becomes visible again after the queue's visibility timeout (the retry delay).
 *
 * Written against the official SDK but not exercised by the tests; it needs real AWS resources.
 */
export class SnsSqsBus implements MessageBus {
  constructor(
    private readonly sns: SNSClient,
    private readonly sqs: SQSClient,
    private readonly topicArn: string,
    private readonly queueUrls: Record<string, string>,
  ) {}

  async publish(event: EventEnvelope): Promise<void> {
    await this.sns.send(
      new PublishCommand({
        TopicArn: this.topicArn,
        Message: JSON.stringify(event),
        MessageAttributes: { type: { DataType: 'String', StringValue: event.type } },
      }),
    );
  }

  async receive(consumer: string, { max, waitMs }: { max: number; waitMs: number }) {
    const response = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl(consumer),
        MaxNumberOfMessages: Math.min(max, 10), // SQS limit
        WaitTimeSeconds: Math.min(20, Math.ceil(waitMs / 1000)),
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    return (response.Messages ?? []).map((message): ReceivedMessage => ({
      event: JSON.parse(message.Body ?? '{}') as EventEnvelope,
      deliveryCount: Number(message.Attributes?.ApproximateReceiveCount ?? 1),
      receipt: message.ReceiptHandle ?? '',
    }));
  }

  async ack(consumer: string, message: ReceivedMessage): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl(consumer),
        ReceiptHandle: message.receipt,
      }),
    );
  }

  async close(): Promise<void> {
    this.sns.destroy();
    this.sqs.destroy();
  }

  private queueUrl(consumer: string): string {
    const url = this.queueUrls[consumer];
    if (!url) throw new Error(`No SQS queue configured for consumer "${consumer}"`);
    return url;
  }
}
