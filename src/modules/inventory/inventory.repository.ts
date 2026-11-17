import { BaseRepository } from '../../common/base-repository';
import type { Db } from '../../common/db';
import type { Prisma, ReservationStatus, StockReservation } from '../../generated/prisma/client';

/**
 * Stock reservations, plus the two stock movements inventory is allowed to make on the products
 * table. The products module owns the catalogue; inventory owns how stock moves during checkout.
 */
export class ReservationRepository extends BaseRepository<
  StockReservation,
  Prisma.StockReservationUncheckedCreateInput,
  Prisma.StockReservationUncheckedUpdateInput,
  Prisma.StockReservationWhereInput
> {
  protected delegate(db: Db) {
    return db.stockReservation;
  }

  /**
   * Takes `quantity` units if, and only if, that many are available. This is one conditional
   * UPDATE (`... SET stock = stock - q WHERE id = ? AND stock >= q`). Postgres row-locks the
   * product, so concurrent reservations queue up and each one sees the stock left by the last.
   */
  async takeStock(db: Db, productId: string, quantity: number): Promise<boolean> {
    const { count } = await db.product.updateMany({
      where: { id: productId, stock: { gte: quantity } },
      data: { stock: { decrement: quantity } },
    });
    return count === 1;
  }

  async returnStock(db: Db, productId: string, quantity: number): Promise<void> {
    await db.product.update({
      where: { id: productId },
      data: { stock: { increment: quantity } },
    });
  }

  async createMany(db: Db, rows: Prisma.StockReservationCreateManyInput[]): Promise<void> {
    await db.stockReservation.createMany({ data: rows });
  }

  findByOrder(db: Db, orderId: string) {
    return db.stockReservation.findMany({ where: { orderId }, orderBy: { productId: 'asc' } });
  }

  async setStatus(db: Db, ids: string[], status: ReservationStatus): Promise<void> {
    await db.stockReservation.updateMany({ where: { id: { in: ids } }, data: { status } });
  }
}
