import { SNSClient } from '@aws-sdk/client-sns';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { Config } from '../../common/config';
import { getRedis } from '../../common/redis';
import type { MessageBus } from './message-bus';
import { RedisStreamsBus } from './redis-streams.bus';
import { SnsSqsBus } from './sns-sqs.bus';

export * from './message-bus';

// Factory: picks the broker from config, so the relay and consumers are broker-agnostic.
export function createMessageBus(config: Config): MessageBus {
  if (config.MESSAGE_BUS === 'sns-sqs') {
    // Presence of these values is guaranteed by the config schema when MESSAGE_BUS=sns-sqs.
    return new SnsSqsBus(
      new SNSClient({ region: config.AWS_REGION }),
      new SQSClient({ region: config.AWS_REGION }),
      config.SNS_TOPIC_ARN!,
      {
        inventory: config.SQS_QUEUE_URL_INVENTORY!,
        payments: config.SQS_QUEUE_URL_PAYMENTS!,
        orders: config.SQS_QUEUE_URL_ORDERS!,
      },
    );
  }
  return new RedisStreamsBus(getRedis(), config.EVENTS_STREAM, config.RETRY_DELAY_MS);
}
