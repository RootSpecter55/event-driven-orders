import { BaseRepository } from '../../common/base-repository';
import type { Db } from '../../common/db';
import { ConflictError } from '../../common/errors';
import type { Order, OrderStatus, Prisma } from '../../generated/prisma/client';

export type NewOrder = {
  customerEmail: string;
  paymentToken: string;
  totalCents: number;
  items: { productId: string; quantity: number; unitPriceCents: number }[];
};

export class OrderRepository extends BaseRepository<
  Order,
  Prisma.OrderUncheckedCreateInput,
  Prisma.OrderUncheckedUpdateInput,
  Prisma.OrderWhereInput
> {
  protected delegate(db: Db) {
    return db.order;
  }

  createWithItems(db: Db, { items, ...order }: NewOrder) {
    return db.order.create({
      data: { ...order, items: { create: items } },
      include: { items: true },
    });
  }

  findWithItems(db: Db, id: string) {
    return db.order.findUnique({ where: { id }, include: { items: true } });
  }

  /**
   * Moves the order only if it is still in `from` (compare-and-set), so a stale or concurrent
   * handler can never overwrite a newer status.
   */
  async transition(
    db: Db,
    id: string,
    from: OrderStatus,
    to: OrderStatus,
    failureReason?: string,
  ): Promise<Order> {
    const { count } = await db.order.updateMany({
      where: { id, status: from },
      data: { status: to, ...(failureReason ? { failureReason } : {}) },
    });
    if (count !== 1) throw new ConflictError(`Order ${id} is no longer ${from}`);
    return db.order.findUniqueOrThrow({ where: { id } });
  }
}
