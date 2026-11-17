import { createApiKeyAuth } from './common/auth-middleware';
import { getConfig, type Config } from './common/config';
import { dbContext } from './common/db';
import { EventConsumer } from './modules/events/event-consumer';
import { EventsController } from './modules/events/events.controller';
import {
  DeadLetterRepository,
  InboxRepository,
  OutboxRepository,
} from './modules/events/events.repository';
import { EventsService } from './modules/events/events.service';
import { OutboxRelay } from './modules/events/outbox-relay';
import { INVENTORY_CONSUMER, inventoryHandlers } from './modules/inventory/inventory.consumer';
import { InventoryController } from './modules/inventory/inventory.controller';
import { ReservationRepository } from './modules/inventory/inventory.repository';
import { InventoryService } from './modules/inventory/inventory.service';
import {
  CheckoutSaga,
  checkoutSagaHandlers,
  ORDERS_CONSUMER,
} from './modules/orders/checkout-saga';
import { OrdersController } from './modules/orders/orders.controller';
import { OrderRepository } from './modules/orders/orders.repository';
import { OrdersService } from './modules/orders/orders.service';
import { PAYMENTS_CONSUMER, paymentsHandlers } from './modules/payments/payments.consumer';
import { PaymentsController } from './modules/payments/payments.controller';
import { PaymentRepository } from './modules/payments/payments.repository';
import { PaymentsService } from './modules/payments/payments.service';
import { ProductsController } from './modules/products/products.controller';
import { ProductRepository } from './modules/products/products.repository';
import { ProductsService } from './modules/products/products.service';
import { createMessageBus, type MessageBus } from './providers/message-bus';
import { FakePaymentProvider } from './providers/payment/fake.provider';
import type { PaymentProvider } from './providers/payment/payment-provider';

/** Tests replace config values or providers here instead of patching modules. */
export type ContainerOverrides = {
  config?: Partial<Config>;
  paymentProvider?: PaymentProvider;
};

/** Composition root: builds every provider, repository, service and controller in one place. */
export function buildContainer(overrides: ContainerOverrides = {}) {
  const config: Config = { ...getConfig(), ...overrides.config };
  const paymentProvider =
    overrides.paymentProvider ?? new FakePaymentProvider(config.FAKE_PAYMENT_DECLINE);

  const repos = {
    products: new ProductRepository(),
    orders: new OrderRepository(),
    reservations: new ReservationRepository(),
    payments: new PaymentRepository(),
    outbox: new OutboxRepository(),
    inbox: new InboxRepository(),
    deadLetters: new DeadLetterRepository(),
  };

  const services = {
    products: new ProductsService(dbContext, repos.products),
    orders: new OrdersService(dbContext, repos.orders, repos.products, repos.outbox),
    inventory: new InventoryService(
      dbContext,
      repos.reservations,
      repos.outbox,
      config.RESERVATION_TTL_SECONDS,
    ),
    payments: new PaymentsService(dbContext, repos.payments, repos.outbox, paymentProvider),
    events: new EventsService(dbContext, repos.outbox, repos.deadLetters),
  };
  const saga = new CheckoutSaga(repos.orders, repos.outbox);

  /** Worker side: the relay and one consumer per module. Only the worker process calls this. */
  function workerParts(bus: MessageBus = createMessageBus(config)) {
    const deps = {
      db: dbContext,
      bus,
      inbox: repos.inbox,
      deadLetters: repos.deadLetters,
      maxAttempts: config.MAX_DELIVERY_ATTEMPTS,
    };
    return {
      bus,
      relay: new OutboxRelay(dbContext, repos.outbox, bus, config.RELAY_BATCH_SIZE),
      consumers: [
        new EventConsumer(INVENTORY_CONSUMER, inventoryHandlers(services.inventory), deps),
        new EventConsumer(PAYMENTS_CONSUMER, paymentsHandlers(services.payments), deps),
        new EventConsumer(ORDERS_CONSUMER, checkoutSagaHandlers(saga), deps),
      ],
      consumerDeps: deps,
    };
  }

  return {
    config,
    repos,
    services,
    workerParts,
    requireAdmin: createApiKeyAuth(config.ADMIN_API_KEY),
    controllers: {
      products: new ProductsController(services.products),
      orders: new OrdersController(services.orders),
      inventory: new InventoryController(services.inventory),
      payments: new PaymentsController(services.payments),
      events: new EventsController(services.events),
    },
  };
}

export type Container = ReturnType<typeof buildContainer>;
