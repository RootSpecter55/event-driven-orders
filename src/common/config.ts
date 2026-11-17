import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((value) => value === 'true');

const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url().optional(),
    ADMIN_API_KEY: z.string().min(16),

    MESSAGE_BUS: z.enum(['redis', 'sns-sqs']).default('redis'),
    EVENTS_STREAM: z.string().min(1).default('events'),
    AWS_REGION: z.string().optional(),
    SNS_TOPIC_ARN: z.string().optional(),
    SQS_QUEUE_URL_INVENTORY: z.string().optional(),
    SQS_QUEUE_URL_PAYMENTS: z.string().optional(),
    SQS_QUEUE_URL_ORDERS: z.string().optional(),

    RELAY_INTERVAL_MS: z.coerce.number().int().positive().default(500),
    RELAY_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
    MAX_DELIVERY_ATTEMPTS: z.coerce.number().int().min(1).default(5),
    RETRY_DELAY_MS: z.coerce.number().int().min(0).default(5000),

    RESERVATION_TTL_SECONDS: z.coerce.number().int().min(0).default(300),
    FAKE_PAYMENT_DECLINE: bool.default(false),
  })
  .superRefine((env, ctx) => {
    const requireKey = (key: keyof typeof env, reason: string) => {
      if (!env[key])
        ctx.addIssue({ code: 'custom', path: [key], message: `required when ${reason}` });
    };
    if (env.MESSAGE_BUS === 'redis') requireKey('REDIS_URL', 'MESSAGE_BUS=redis');
    if (env.MESSAGE_BUS === 'sns-sqs') {
      for (const key of [
        'AWS_REGION',
        'SNS_TOPIC_ARN',
        'SQS_QUEUE_URL_INVENTORY',
        'SQS_QUEUE_URL_PAYMENTS',
        'SQS_QUEUE_URL_ORDERS',
      ] as const) {
        requireKey(key, 'MESSAGE_BUS=sns-sqs');
      }
    }
  });

export type Config = z.infer<typeof configSchema>;

/** Parses and validates env vars. Throws one error listing every problem, so startup fails fast. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${problems.join('\n')}`);
  }
  return result.data;
}

// Singleton: config is read once and shared, so every module sees the same validated values.
let cached: Config | undefined;
export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}
