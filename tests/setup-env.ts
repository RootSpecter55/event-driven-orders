// Test environment: runs before every test file, before any app module reads config.
// Uses a separate database and Redis db index so tests never touch local development data.
Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://app:app@localhost:5446/orders_test',
  REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6382/1',
  ADMIN_API_KEY: 'test-admin-key-0123456789',
  MESSAGE_BUS: 'redis',
  EVENTS_STREAM: 'events-test',
  RELAY_BATCH_SIZE: '100',
  MAX_DELIVERY_ATTEMPTS: '3',
  // Failed messages are redelivered on the very next poll, so tests need no waiting.
  RETRY_DELAY_MS: '0',
  RESERVATION_TTL_SECONDS: '300',
  FAKE_PAYMENT_DECLINE: 'false',
});
