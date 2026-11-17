import { BaseRepository } from '../../common/base-repository';
import type { Db } from '../../common/db';
import type { Payment, Prisma } from '../../generated/prisma/client';

export class PaymentRepository extends BaseRepository<
  Payment,
  Prisma.PaymentUncheckedCreateInput,
  Prisma.PaymentUncheckedUpdateInput,
  Prisma.PaymentWhereInput
> {
  protected delegate(db: Db) {
    return db.payment;
  }

  findByOrder(db: Db, orderId: string) {
    return db.payment.findUnique({ where: { orderId } });
  }
}
