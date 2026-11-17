import type { DbContext } from '../../common/db';
import { AppError, NotFoundError } from '../../common/errors';
import { toPage, toSkipTake } from '../../common/pagination';
import type { Order } from '../../generated/prisma/client';
import type { OutboxRepository } from '../events/events.repository';
import type { ProductRepository } from '../products/products.repository';
import type { OrderRepository } from './orders.repository';
import type { ListOrdersQuery, PlaceOrderInput } from './orders.schemas';

/** The payment token is passed to the payment provider and never returned by the API. */
function toView<T extends Order>(order: T) {
  const { paymentToken: _omit, ...rest } = order;
  return rest;
}

export class OrdersService {
  constructor(
    private readonly db: DbContext,
    private readonly orders: OrderRepository,
    /** Read-only price lookup in the catalogue. Orders never touch inventory or payments. */
    private readonly products: ProductRepository,
    private readonly outbox: OutboxRepository,
  ) {}

  /**
   * Creates a PENDING order and, in the same transaction, the first saga command. The rest of
   * checkout happens asynchronously in the worker; the client polls GET /orders/:id.
   */
  async place(input: PlaceOrderInput) {
    const productIds = input.items.map((item) => item.productId);
    const products = await this.products.findManyByIds(this.db.client(), productIds);
    const priceOf = new Map(products.map((p) => [p.id, p.priceCents]));
    const unknown = productIds.filter((id) => !priceOf.has(id));
    if (unknown.length > 0) {
      throw new AppError(422, 'UNKNOWN_PRODUCT', 'Some products do not exist', {
        productIds: unknown,
      });
    }

    const lines = input.items.map((item) => ({
      ...item,
      unitPriceCents: priceOf.get(item.productId)!,
    }));
    const totalCents = lines.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0);

    return this.db.transaction(async (tx) => {
      const order = await this.orders.createWithItems(tx, {
        customerEmail: input.customerEmail,
        paymentToken: input.paymentToken,
        totalCents,
        items: lines,
      });
      await this.outbox.append(tx, 'inventory.reserve-requested', order.id, {
        orderId: order.id,
        items: input.items,
      });
      return toView(order);
    });
  }

  async get(orderId: string) {
    const order = await this.orders.findWithItems(this.db.client(), orderId);
    if (!order) throw new NotFoundError('Order');
    return toView(order);
  }

  async list(query: ListOrdersQuery) {
    const { items, total } = await this.orders.list(this.db.client(), {
      where: query.status ? { status: query.status } : {},
      ...toSkipTake(query),
      orderBy: { createdAt: 'desc' },
    });
    return toPage(items.map(toView), total, query);
  }
}
