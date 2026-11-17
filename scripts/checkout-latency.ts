/**
 * Measures how long checkout takes end to end against a running stack (API + worker).
 *
 *   npm run bench:checkout                             # 200 orders, 20 at a time
 *   ORDERS=1000 CONCURRENCY=50 API_URL=http://host:3000 ADMIN_API_KEY=... npm run bench:checkout
 *
 * 1. Creates one product with enough stock for every order.
 * 2. Places ORDERS orders, CONCURRENCY at a time.
 * 3. Polls each order until it is CONFIRMED or CANCELLED and records the time from POST to that.
 * 4. Prints the final-state counts, throughput and latency percentiles.
 *
 * Polling adds up to POLL_MS to each measurement, and everything runs on one machine, so the
 * numbers describe this setup only.
 */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY ?? 'change-me-admin-api-key';
const ORDERS = Number(process.env.ORDERS ?? 200);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 20);
const POLL_MS = Number(process.env.POLL_MS ?? 50);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 60_000);

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ADMIN_API_KEY}`,
      ...init.headers,
    },
  });
  if (!res.ok)
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${await res.text()}`);
  return ((await res.json()) as { data: T }).data;
}

async function checkoutOnce(productId: string): Promise<{ status: string; ms: number }> {
  const started = performance.now();
  const order = await api<{ id: string }>('/orders', {
    method: 'POST',
    body: JSON.stringify({
      customerEmail: 'bench@example.com',
      paymentToken: 'tok_visa',
      items: [{ productId, quantity: 1 }],
    }),
  });
  while (performance.now() - started < TIMEOUT_MS) {
    const { status } = await api<{ status: string }>(`/orders/${order.id}`);
    if (status === 'CONFIRMED' || status === 'CANCELLED') {
      return { status, ms: performance.now() - started };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return { status: 'TIMED_OUT', ms: TIMEOUT_MS };
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

async function main() {
  const product = await api<{ id: string }>('/products', {
    method: 'POST',
    body: JSON.stringify({
      sku: `BENCH-${randomUUID().slice(0, 8)}`,
      name: 'Benchmark item',
      priceCents: 100,
      stock: ORDERS,
    }),
  });

  const results: { status: string; ms: number }[] = [];
  const started = performance.now();
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < ORDERS) {
        next++;
        results.push(await checkoutOnce(product.id));
      }
    }),
  );
  const elapsedSeconds = (performance.now() - started) / 1000;

  const counts: Record<string, number> = {};
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const sorted = results.map((r) => r.ms).sort((a, b) => a - b);

  console.log(`orders: ${ORDERS}, concurrency: ${CONCURRENCY}, poll: ${POLL_MS} ms`);
  console.log('final states:', counts);
  console.log(`throughput: ${(ORDERS / elapsedSeconds).toFixed(1)} orders/s`);
  for (const p of [50, 95, 99]) console.log(`p${p}: ${percentile(sorted, p).toFixed(0)} ms`);
  console.log(`max: ${(sorted.at(-1) ?? 0).toFixed(0)} ms`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
