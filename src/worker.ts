import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { getConfig } from './common/config';
import { getPrisma } from './common/db';
import { logger } from './common/logger';
import { getRedis } from './common/redis';
import { buildContainer } from './container';

/** A loop that has not finished an iteration for this long makes /health fail. */
const STALE_AFTER_MS = 30_000;

/**
 * Worker entrypoint: the outbox relay and the inventory, payments and orders consumers, each in
 * its own loop. It serves only GET /health, so the container healthcheck works as for the API.
 */
export function startWorker() {
  const config = getConfig();
  const { relay, consumers, bus } = buildContainer().workerParts();
  const lastTick = new Map<string, number>();
  let running = true;

  async function loop(name: string, iteration: () => Promise<void>) {
    while (running) {
      try {
        await iteration();
        lastTick.set(name, Date.now());
      } catch (err) {
        logger.error({ err, loop: name }, 'Worker loop failed, retrying');
        await sleep(1000);
      }
    }
  }

  const loops = [
    loop('relay', async () => {
      const published = await relay.runOnce();
      if (published === 0) await sleep(config.RELAY_INTERVAL_MS);
    }),
    ...consumers.map((consumer) =>
      loop(consumer.name, async () => {
        await consumer.pollOnce(1000);
      }),
    ),
  ];

  const health = createServer((req, res) => {
    const now = Date.now();
    const names = ['relay', ...consumers.map((c) => c.name)];
    const stale = names.filter((name) => now - (lastTick.get(name) ?? 0) > STALE_AFTER_MS);
    const ok = req.url === '/health' && stale.length === 0;
    res.writeHead(req.url === '/health' ? (ok ? 200 : 503) : 404, {
      'Content-Type': 'application/json',
    });
    res.end(
      JSON.stringify(
        ok
          ? { data: { status: 'ok' } }
          : { error: { code: 'UNHEALTHY', message: `Stale loops: ${stale.join(', ')}` } },
      ),
    );
  });
  health.listen(config.PORT, () => logger.info(`Worker running, health on port ${config.PORT}`));

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, stopping worker loops`);
    running = false;
    await Promise.all(loops);
    health.close();
    await bus.close();
    if (config.MESSAGE_BUS === 'redis') await getRedis().quit();
    await getPrisma().$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (require.main === module) {
  startWorker();
}
