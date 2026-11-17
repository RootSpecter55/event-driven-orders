# event-driven-orders

A shop checkout split into **orders**, **inventory** and **payments** modules that never call each other. They communicate only through events. Checkout is an orchestrated saga (reserve stock, then charge, then confirm), and a failed step is undone by running compensations in reverse order.

The interesting parts are the mechanisms that make event-driven code reliable:

- **Transactional outbox.** A state change and the event it causes are written in one database transaction.
- **Idempotent consumers.** An inbox table makes the duplicates that at-least-once delivery produces harmless.
- **Retries with dead letters,** plus a redrive endpoint.
- **An explicit order state machine.**
- **Stock reservation that never oversells.**

Each mechanism is proven by a test.

**What runs where:** everything runs locally with Docker, with no cloud account or API keys. The message bus is Redis Streams and payments use a fake provider. An SNS + SQS message bus exists behind the same interface but is not exercised by the tests. The project is **not deployed**.

**Stack:** Node 24, TypeScript (strict), Express 5, Prisma 7, PostgreSQL 16, Redis 7 (Streams), Zod, Jest + Supertest, ESLint + Prettier.

## Architecture

```mermaid
flowchart LR
  Client -->|POST /orders| API

  subgraph API["API process"]
    direction TB
    R[routes → controllers] --> SV[services]
  end
  SV -->|"one transaction:<br/>order row + outbox row"| PG[(PostgreSQL)]

  subgraph Worker["Worker process (same codebase)"]
    direction TB
    RL[Outbox relay]
    INV[inventory consumer]
    PAY[payments consumer]
    ORD["orders consumer<br/>(checkout saga)"]
  end

  PG -->|"unpublished rows<br/>FOR UPDATE SKIP LOCKED"| RL
  RL -->|publish| BUS{{MessageBus}}
  BUS --> RS[Redis Streams<br/>one consumer group per consumer]
  BUS -.-> SNS[SNS topic + SQS queue per consumer]
  RS --> INV & PAY & ORD
  INV & PAY & ORD -->|"one transaction:<br/>inbox row + effects + outbox rows"| PG
  PAY --> PP{{PaymentProvider}} --> FAKE[Fake: declines tok_declined]
```

The dashed line is the AWS message bus, selected with `MESSAGE_BUS=sns-sqs`.

The checkout saga, driven by the orders module:

```mermaid
sequenceDiagram
  participant O as orders (saga)
  participant I as inventory
  participant P as payments
  O->>I: inventory.reserve-requested
  I-->>O: inventory.stock-reserved (or reservation-failed → CANCELLED)
  O->>P: payment.charge-requested
  P-->>O: payment.charged (or payment.declined → release → CANCELLED)
  O->>I: inventory.commit-requested
  I-->>O: inventory.stock-committed → CONFIRMED (or commit-failed → refund → release → CANCELLED)
```

Every arrow is an event row written to the outbox and delivered through the bus. Nothing calls across modules.

```
src/
  common/      config, logger, errors + handler, validate, pagination, API-key auth,
               db (Prisma singleton + transactions), redis, base repository, response helpers
  providers/   message-bus/ (Redis Streams, SNS+SQS, factory)   payment/ (fake provider)
  modules/     products, orders (+ checkout saga, state machine), inventory, payments,
               events (event contract, outbox relay, consumer runner, dead letters)
  container.ts composition root
  app.ts       HTTP API          server.ts  API entrypoint       worker.ts  worker entrypoint
scripts/       start-with-secrets.ts (container entrypoint), checkout-latency.ts
tests/         unit/ (mocked repositories), integration/ (real Postgres + Redis)
```

Each feature module has `routes → controller → service → repository` plus its own Zod `schemas`. Consumers have a `*.consumer.ts` that maps event types to service methods.

## Data model

```mermaid
erDiagram
  products ||--o{ order_items : "ordered as"
  orders ||--|{ order_items : contains
  products ||--o{ stock_reservations : "held by"
  orders ||--o{ stock_reservations : "holds (by order_id)"
  orders ||--o| payments : "paid by (by order_id)"

  products {
    uuid id PK
    string sku UK
    int price_cents
    int stock "CHECK stock >= 0"
  }
  orders {
    uuid id PK
    enum status "PENDING, STOCK_RESERVED, PAID, CONFIRMED, COMPENSATING, CANCELLED"
    int total_cents
    string payment_token
    string failure_reason
  }
  order_items {
    uuid id PK
    uuid order_id FK
    uuid product_id FK
    int quantity
    int unit_price_cents
  }
  stock_reservations {
    uuid id PK
    uuid order_id "unique with product_id"
    uuid product_id FK
    int quantity
    enum status "RESERVED, COMMITTED, RELEASED"
    timestamp expires_at
  }
  payments {
    uuid id PK
    uuid order_id UK
    enum status "CHARGED, DECLINED, REFUNDED"
    string provider_charge_id
  }
  outbox_events {
    uuid id PK
    uuid event_id
    string type
    json payload
    timestamp published_at "null until relayed"
  }
  inbox_entries {
    uuid id PK
    string consumer "unique with event_id"
    uuid event_id
  }
  dead_letters {
    uuid id PK
    string consumer
    uuid event_id
    string error
    int attempts
    timestamp redriven_at
  }
```

`stock_reservations` and `payments` hold an `order_id` but have no foreign key to `orders`. Inventory and payments know orders only through events.

## Run it

Requires Docker.

```bash
cp .env.example .env
docker compose up --build
```

This starts:

- Postgres on host port **5446** and Redis on **6382**.
- A one-off `migrate` container.
- The **api** on <http://localhost:3000>.
- The **worker** (outbox relay and the three consumers).

The api and worker are the same image with different commands.

```bash
ADMIN='Authorization: Bearer change-me-admin-api-key'

# Create a product with 2 in stock
P=$(curl -s localhost:3000/products -H "$ADMIN" -H 'Content-Type: application/json' \
  -d '{"sku":"LAMP-1","name":"Desk lamp","priceCents":4500,"stock":2}' | jq -r .data.id)

# Place an order (202 Accepted, status PENDING)
O=$(curl -s localhost:3000/orders -H 'Content-Type: application/json' \
  -d "{\"customerEmail\":\"ada@example.com\",\"paymentToken\":\"tok_visa\",\"items\":[{\"productId\":\"$P\",\"quantity\":1}]}" | jq -r .data.id)

curl -s localhost:3000/orders/$O | jq .data.status        # "CONFIRMED" a moment later

# The same with "paymentToken":"tok_declined" ends CANCELLED / PAYMENT_DECLINED, with the stock returned.
curl -s "localhost:3000/events/outbox?pageSize=50" -H "$ADMIN" | jq '[.data[].type]'
```

### Tests and lint

```bash
docker compose up -d postgres redis   # tests use the orders_test database (created automatically) and Redis db 1
npm ci
npm run lint
npm test                              # unit + integration
```

Integration tests don't start the worker loops. They call `relay.runOnce()` and `consumer.pollOnce()` directly until nothing is left to do (`settle()` in `tests/integration/helpers.ts`), so the saga tests are deterministic.

`npm run dev` and `npm run dev:worker` run the two processes from your shell with live reload.

## Endpoints

Every response uses one envelope: `{ "data": … }`, plus `"meta": { page, pageSize, total, totalPages }` on lists. Errors are `{ "error": { "code", "message", "details"? } }`. Every list takes `?page=&pageSize=` (max 100). Bodies, query strings and path params are all validated. **admin** means `Authorization: Bearer $ADMIN_API_KEY`.

| Method | Path                                         | Access | Notes                                                  |
| ------ | -------------------------------------------- | ------ | ------------------------------------------------------ |
| GET    | `/health`                                    | public |                                                        |
| POST   | `/products`                                  | admin  | `{sku, name, priceCents, stock}`                       |
| GET    | `/products` · `/products/:productId`         | public |                                                        |
| PATCH  | `/products/:productId`                       | admin  | `{name?, priceCents?}`                                 |
| POST   | `/products/:productId/restock`               | admin  | `{quantity}`, atomic increment                         |
| POST   | `/orders`                                    | public | 202. `{customerEmail, paymentToken, items[]}`          |
| GET    | `/orders` · `/orders/:orderId`               | public | `?status=` filter; the payment token is never returned |
| GET    | `/inventory/reservations`                    | admin  | `?orderId=`                                            |
| GET    | `/payments`                                  | admin  | `?orderId=`                                            |
| GET    | `/events/outbox`                             | admin  | `?published=true\|false`                               |
| GET    | `/events/dead-letters`                       | admin  | `?consumer=`                                           |
| POST   | `/events/dead-letters/:deadLetterId/redrive` | admin  | 202; 409 if already redriven                           |

## Key design decisions

**Transactional outbox instead of publishing from the request.** `OrdersService.place()` writes the order and an `inventory.reserve-requested` row to `outbox_events` in one transaction. If the transaction rolls back there is no event; if it commits the event can't be lost.

`OutboxRelay.runOnce()` (`src/modules/events/outbox-relay.ts`) does three things in one transaction:

1. Locks a batch of unpublished rows with `FOR UPDATE SKIP LOCKED`, so a second relay takes a different batch.
2. Publishes them.
3. Marks them published.

A crash between steps 2 and 3 means the rows are published again on the next run. Delivery is at-least-once by design.

**Inbox for exactly-once effects.** `EventConsumer.process()` (`src/modules/events/event-consumer.ts`) is shared by all three consumers:

1. Skips events already in `inbox_entries`.
2. Otherwise inserts the inbox row first.
3. Runs the handler, which writes its own outbox events, in the same transaction.

The effects, the inbox row and the outgoing events commit together, or none of them do. The unique `(consumer, event_id)` key covers two copies arriving at the same moment: the second blocks on the key and then fails.

**Retries and dead letters use the broker's delivery count.** Redis Streams keeps unacked entries in the group's pending list. `receive()` claims entries idle for longer than `RETRY_DELAY_MS`, and claiming raises their delivery count. SQS has `ApproximateReceiveCount` for the same purpose. On the last allowed attempt (`MAX_DELIVERY_ATTEMPTS`), the consumer stores the message in `dead_letters` and acks it. Redrive re-queues it through the outbox with its original event id, so consumers that already handled it skip it.

**Orchestrated saga with an explicit state machine.** `CheckoutSaga` (`src/modules/orders/checkout-saga.ts`) is a handful of short handlers, one per reply. Each moves the order and appends the next command. The allowed moves are one table in `order-status.ts`:

| From           | Allowed to                |
| -------------- | ------------------------- |
| PENDING        | STOCK_RESERVED, CANCELLED |
| STOCK_RESERVED | PAID, COMPENSATING        |
| PAID           | CONFIRMED, COMPENSATING   |
| COMPENSATING   | CANCELLED                 |

`CONFIRMED` and `CANCELLED` are final. The update is a compare-and-set (`WHERE id = ? AND status = ?`). A reply that doesn't fit the current state throws, is retried, and ends in the dead-letter table, where it can be inspected.

Compensations run in reverse:

- **Declined payment:** release the stock.
- **Failed commit:** refund, then release.

A commit fails when the stock hold (`RESERVATION_TTL_SECONDS`) expired before the payment finished.

**No overselling without application locks.** Reserving is one conditional statement: `UPDATE products SET stock = stock - q WHERE id = ? AND stock >= q`. Postgres row locks serialise concurrent reservations, and each one sees the stock the previous one left. Multi-item orders lock products in id order, so two orders can't deadlock. When a later item fails, the order hands back what it already took, within the same transaction. A `CHECK (stock >= 0)` constraint is the last line of defence.

**Orders reads the product catalogue directly.** It looks up prices when an order is placed. That is a read of catalogue data, not a call into inventory or payments. Those three modules only share the event contract in `event-types.ts`, where every payload has a Zod schema that is checked when the event is written and again when it is consumed.

**Patterns, only where they earn their place.**

- _Singleton:_ the Prisma client, the shared Redis connection and config.
- _Factory:_ `createMessageBus()` picks Redis Streams or SNS+SQS.
- _Repository:_ all data access.
- _State machine:_ the order lifecycle.

The payment provider has a single (fake) implementation, so it has no factory.

## Results

Not yet measured, run `npm run bench:checkout`.

## Known limitations

- **Ordering is per message, not global.** The relay publishes in creation order, but retries can deliver a later event first. The saga copes because each order's steps are causal (a reply can't exist before its command), and the state machine rejects anything out of place.
- **The payment call runs inside the consumer's database transaction.** If that transaction rolls back after a successful charge, the retry reuses the idempotency key. The fake provider honours idempotency keys only in memory; a real processor such as Stripe keeps them server-side.
- **No reservation sweeper.** An expired hold is released by its saga's compensation. If a saga stalled completely (for example, a dead-lettered payment request), the stock stays held until the dead letter is redriven.
- **No real payment adapter** is included; the fake is the only `PaymentProvider`.
- **The SNS + SQS bus is not tested.** It assumes one SQS queue per consumer, subscribed to the topic with raw message delivery, and uses the queue's visibility timeout as the retry delay.
- **The Redis stream is capped at about 100k entries** (`MAXLEN ~`), and consumer groups start from the beginning of the stream when first created. A new consumer would therefore replay recent history (harmless, thanks to the inbox).
- **No customer accounts:** order endpoints are public and orders are identified by id. There is no idempotency key on `POST /orders`, so a retried request creates a second order.
- **Inbox rows are never pruned.** A real system would delete entries older than the longest possible redelivery window.

## Deployment

| File                                     | Purpose                                                                                                                                                                                                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`                             | Multi-stage build: compiles TypeScript, then ships production dependencies and `dist/` only. Runs as the non-root `node` user, with a healthcheck on `/health`. The same image runs the API and, with the `worker` argument, the worker.                        |
| `scripts/start-with-secrets.ts`          | Container entrypoint. With `SECRETS_SOURCE=aws` it loads one JSON secret (`SECRET_ID`) from AWS Secrets Manager into the environment; with `local` it uses `.env`. It fails fast if the secret or a required key is missing, then starts the API or the worker. |
| `deploy/ecs-task-definition.json`        | ECS Fargate task definition template for the API, with `${…}` placeholders for account id, region, image tag, role ARNs, secret id, topic and queues.                                                                                                           |
| `deploy/ecs-task-definition.worker.json` | The same for the worker: a separate task, so it scales independently of the API.                                                                                                                                                                                |
| `.github/workflows/deploy.yml`           | Manual-only (`workflow_dispatch`) workflow. It assumes an AWS role through GitHub OIDC (no stored keys), builds and pushes the image to ECR, fills in both task definitions with `envsubst` and updates both ECS services.                                      |
| `.github/workflows/ci.yml`               | Runs lint, typecheck and the full test suite against Postgres and Redis service containers on every push and pull request.                                                                                                                                      |

Deployment config is provided as a reference. This project has not been deployed.
