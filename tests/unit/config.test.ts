import { loadConfig } from '../../src/common/config';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379/0',
  ADMIN_API_KEY: 'x'.repeat(16),
};

describe('loadConfig', () => {
  it('applies defaults to a minimal valid environment', () => {
    expect(loadConfig(base)).toMatchObject({
      PORT: 3000,
      MESSAGE_BUS: 'redis',
      MAX_DELIVERY_ATTEMPTS: 5,
      FAKE_PAYMENT_DECLINE: false,
    });
  });

  it('lists every missing or invalid variable in one error', () => {
    try {
      loadConfig({ PORT: 'abc', FAKE_PAYMENT_DECLINE: 'yes' });
      throw new Error('expected loadConfig to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('Invalid configuration');
      for (const key of ['PORT', 'DATABASE_URL', 'ADMIN_API_KEY', 'FAKE_PAYMENT_DECLINE']) {
        expect(message).toContain(`- ${key}:`);
      }
    }
  });

  it('requires each message bus to have its own settings', () => {
    const { REDIS_URL: _omit, ...withoutRedis } = base;
    expect(() => loadConfig(withoutRedis)).toThrow(/REDIS_URL: required when MESSAGE_BUS=redis/);
    expect(() => loadConfig({ ...base, MESSAGE_BUS: 'sns-sqs' })).toThrow(
      /SNS_TOPIC_ARN: required when MESSAGE_BUS=sns-sqs/,
    );
  });
});
