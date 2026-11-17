# PLAN — event-driven-orders

A shop checkout split into modules that never call each other: **orders**, **inventory** and **payments** only talk through events. Every state change and the event it causes are written in one database transaction (transactional outbox). A relay worker publishes those events to a message bus, and consumers handle each event exactly once thanks to an inbox table. Checkout is an orchestrated saga: reserve stock, then charge, then confirm. A failure runs the compensations in reverse order.

**Stack:** Node 24, TypeScript 5.9 (strict), Express 5, Prisma 7 (`@prisma/adapter-pg`), Zod 4, ioredis, pino, Jest 30 with Supertest, ESLint and Prettier, PostgreSQL 16, Redis 7 (Streams).

## Modules

| Module    | Responsibility                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| products  | Catalogue: create, list, get, update and restock products. Each product has a price and a stock count.                                                                         |
| orders    | Place an order (202 Accepted) and read orders. Holds the **checkout saga**, which reacts to inventory and payment events and drives the order through its state machine.       |
| inventory | Consumer of `inventory.*` commands: reserve stock (atomic, never oversells), commit a reservation, release it. Lists reservations.                                               |
| payments  | Consumer of `payment.*` commands: charge and refund through `PaymentProvider`. Lists payments.                                                                                  |
| events    | Outbox, inbox and dead letters. The outbox relay, the generic consumer runner (inbox check, retries, dead-lettering), event payload schemas, and admin endpoints with redrive. |

**Shared code (`src/common/`):** config (Zod-validated env), logger, error classes and the global error handler, `validate` middleware, pagination helper, API-key auth middleware, base repository, Prisma client and transaction helper, Redis client, response helpers.

**Providers (`src/providers/`):**

- `MessageBus`: `RedisStreamsBus` (default; one stream, one consumer group per consumer) or `SnsSqsBus` (publish to an SNS topic, receive from one SQS queue per consumer; written against the AWS SDK, not exercised). A factory picks one from `MESSAGE_BUS`.
- `PaymentProvider`: `FakePaymentProvider` only. It declines the token `tok_declined`, or every charge when `FAKE_PAYMENT_DECLINE=true`. No real payment adapter is included.

**Entrypoints:** `src/server.ts` (HTTP API) and `src/worker.ts` (outbox relay plus the three consumers, with a small `/health` endpoint). Both use the same modules and run as separate docker-compose services.

## Data model

```
Product          id, sku (unique), name, priceCents, stock (CHECK stock >= 0), createdAt, updatedAt
Order            id, customerEmail, status, totalCents, paymentToken, failureReason?, createdAt, updatedAt
OrderItem        id, orderId, productId, quantity, unitPriceCents
StockReservation id, orderId, productId, quantity, status (RESERVED|COMMITTED|RELEASED), expiresAt   unique(orderId, productId)
Payment          id, orderId (unique), amountCents, status (CHARGED|DECLINED|REFUNDED), providerChargeId?, declineReason?
OutboxEvent      id, eventId, type, aggregateId, payload (json), createdAt, publishedAt?            index(publishedAt, createdAt)
InboxEntry       id, consumer, eventId, eventType, processedAt                                       unique(consumer, eventId)
DeadLetter       id, consumer, eventId, eventType, payload, error, attempts, createdAt, redrivenAt?
```

## Mechanisms

**Transactional outbox.** Services never publish. They insert an `outbox_events` row inside the same transaction as the state change. The relay locks a batch of unpublished rows (`FOR UPDATE SKIP LOCKED`), publishes them, then marks them published. If it crashes after publishing but before the mark commits, those rows are published again on the next run. That gives at-least-once delivery.

**Idempotent consumers (inbox).** The consumer runner first checks `inbox_entries` for `(consumer, eventId)` and acks known events. Otherwise it opens a transaction that inserts the inbox row, then runs the handler, which also writes its own outbox events. Effects, inbox row and outgoing events commit together, or none of them do. The unique constraint covers the race where two copies are handled at once.

**Retries and dead letters.** Each received message has a delivery count, which both brokers supply: Redis Streams through the pending entries list, and SQS through `ApproximateReceiveCount`. A failed message is left un-acked and redelivered after `RETRY_DELAY_MS`. Once the count reaches `MAX_DELIVERY_ATTEMPTS`, the message is written to `dead_letters` and acked. `POST /events/dead-letters/:id/redrive` re-publishes it through the outbox with the same event id, so consumers that already handled it skip it.

**Checkout saga (orchestrated by orders).**

```
place order ─► inventory.reserve-requested
  stock-reserved      ─► payment.charge-requested            (else reservation-failed ─► CANCELLED)
  payment.charged     ─► inventory.commit-requested          (else payment.declined ─► release)
  stock-committed     ─► CONFIRMED                           (else commit-failed   ─► refund ─► release)
  stock-released      ─► CANCELLED
```

The commit fails when the reservation expired before payment finished (`RESERVATION_TTL_SECONDS`). That is the path where a charge has to be refunded.

**Order state machine:** one table in `order-status.ts`:

| From           | Allowed to                |
| -------------- | ------------------------- |
| PENDING        | STOCK_RESERVED, CANCELLED |
| STOCK_RESERVED | PAID, COMPENSATING        |
| PAID           | CONFIRMED, COMPENSATING   |
| COMPENSATING   | CANCELLED                 |
| CONFIRMED      | (final)                   |
| CANCELLED      | (final)                   |

The update is conditional on the current status (`WHERE id = ? AND status = ?`), so a stale handler can't overwrite a newer state.

**No overselling.** A reservation is a single conditional statement: `UPDATE products SET stock = stock - q WHERE id = ? AND stock >= q`. Products in an order are locked in id order to avoid deadlocks. A `CHECK (stock >= 0)` constraint backs this up.

## Endpoints

Envelope: `{ data, meta? }` / `{ error: { code, message, details? } }`. Every list is paginated (`?page=&pageSize=`). `[admin]` means `Authorization: Bearer $ADMIN_API_KEY`.

```
GET   /health
POST  /products                         [admin]
GET   /products
GET   /products/:productId
PATCH /products/:productId              [admin]
POST  /products/:productId/restock      [admin]
POST  /orders                           202, starts the saga
GET   /orders                           ?status=
GET   /orders/:orderId
GET   /inventory/reservations           [admin] ?orderId=
GET   /payments                         [admin] ?orderId=
GET   /events/outbox                    [admin] ?published=true|false
GET   /events/dead-letters              [admin]
POST  /events/dead-letters/:id/redrive  [admin]
```

## Tests that prove the mechanisms

- **Duplicate from a relay crash:** the relay publishes, then fails before marking rows published. A second relay run publishes the same event again, so the stream holds two copies. Inventory handles it once: one inbox row, and stock goes down once.
- **Declined payment releases stock:** an order with `tok_declined` ends CANCELLED (`PAYMENT_DECLINED`), the reservation is RELEASED and stock is back to its starting value.
- **No overselling:** ten concurrent reservations for a product with stock 1 give exactly one success, and stock ends at 0. End to end, five concurrent orders for the last item give one CONFIRMED order and four CANCELLED (`OUT_OF_STOCK`).
- **Refund path:** with a zero reservation TTL the commit fails, the payment is REFUNDED, the stock is released and the order is CANCELLED.
- **Dead letters:** a handler that always fails is dead-lettered after N deliveries, and its redrive is processed once the handler works.
- **Unit:** state-machine table, saga handlers, consumer runner, fake payment provider, config, `start-with-secrets`.

## Build order

1. Scaffold: tooling, docker-compose, CI, `.env.example`
2. Common layer and `/health`
3. Prisma schema and migration
4. events: outbox, relay, inbox, consumer runner, message buses
5. products
6. inventory, payments, orders and the saga
7. Worker entrypoint, dead-letter endpoints
8. Tests
9. Deployment files
10. README
