import { BaseRepository } from '../../common/base-repository';
import type { Db } from '../../common/db';
import type { Prisma, Product } from '../../generated/prisma/client';

export class ProductRepository extends BaseRepository<
  Product,
  Prisma.ProductUncheckedCreateInput,
  Prisma.ProductUncheckedUpdateInput,
  Prisma.ProductWhereInput
> {
  protected delegate(db: Db) {
    return db.product;
  }

  findManyByIds(db: Db, ids: string[]) {
    return db.product.findMany({ where: { id: { in: ids } } });
  }

  findBySku(db: Db, sku: string) {
    return db.product.findUnique({ where: { sku } });
  }

  addStock(db: Db, id: string, quantity: number) {
    return db.product.update({ where: { id }, data: { stock: { increment: quantity } } });
  }
}
