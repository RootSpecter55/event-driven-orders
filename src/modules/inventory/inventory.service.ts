import type { Db, DbContext } from '../../common/db';
import { toPage, toSkipTake } from '../../common/pagination';
import type { EventPayload } from '../events/event-types';
import type { OutboxRepository } from '../events/events.repository';
import type { ReservationRepository } from './inventory.repository';
import type { ListReservationsQuery } from './inventory.schemas';

/**
 * Handles the saga's inventory commands. Each method runs inside the consumer's transaction and
 * replies by appending an event to the outbox; it never calls orders or payments.
 */
export class InventoryService {
  constructor(
    private readonly db: DbContext,
    private readonly reservations: ReservationRepository,
    private readonly outbox: OutboxRepository,
    private readonly reservationTtlSeconds: number,
  ) {}

  /** All-or-nothing: either every item is reserved, or none is and the order is told why. */
  async reserve(tx: Db, { orderId, items }: EventPayload<'inventory.reserve-requested'>) {
    // Lock products in a fixed order, so two multi-item orders can never deadlock each other.
    const sorted = [...items].sort((a, b) => a.productId.localeCompare(b.productId));
    const taken: typeof sorted = [];

    for (const item of sorted) {
      if (!(await this.reservations.takeStock(tx, item.productId, item.quantity))) {
        // Hand back what this order already took. We are still in the same transaction.
        for (const done of taken) {
          await this.reservations.returnStock(tx, done.productId, done.quantity);
        }
        await this.outbox.append(tx, 'inventory.reservation-failed', orderId, {
          orderId,
          reason: 'OUT_OF_STOCK',
        });
        return;
      }
      taken.push(item);
    }

    const expiresAt = new Date(Date.now() + this.reservationTtlSeconds * 1000);
    await this.reservations.createMany(
      tx,
      sorted.map((item) => ({ orderId, ...item, status: 'RESERVED' as const, expiresAt })),
    );
    await this.outbox.append(tx, 'inventory.stock-reserved', orderId, { orderId });
  }

  /** Turns the hold into a sale. Fails if the hold expired while the payment was running. */
  async commit(tx: Db, orderId: string) {
    const rows = await this.reservations.findByOrder(tx, orderId);
    const now = new Date();
    const held = rows.length > 0 && rows.every((r) => r.status === 'RESERVED' && r.expiresAt > now);

    if (!held) {
      await this.outbox.append(tx, 'inventory.commit-failed', orderId, {
        orderId,
        reason: 'RESERVATION_EXPIRED',
      });
      return;
    }
    await this.reservations.setStatus(
      tx,
      rows.map((r) => r.id),
      'COMMITTED',
    );
    await this.outbox.append(tx, 'inventory.stock-committed', orderId, { orderId });
  }

  /** Compensation for reserve(): returns held stock. Safe to run when nothing is held. */
  async release(tx: Db, orderId: string) {
    const held = (await this.reservations.findByOrder(tx, orderId)).filter(
      (r) => r.status === 'RESERVED',
    );
    for (const row of held) {
      await this.reservations.returnStock(tx, row.productId, row.quantity);
    }
    await this.reservations.setStatus(
      tx,
      held.map((r) => r.id),
      'RELEASED',
    );
    await this.outbox.append(tx, 'inventory.stock-released', orderId, { orderId });
  }

  async list(query: ListReservationsQuery) {
    const { items, total } = await this.reservations.list(this.db.client(), {
      where: query.orderId ? { orderId: query.orderId } : {},
      ...toSkipTake(query),
      orderBy: { createdAt: 'desc' },
    });
    return toPage(items, total, query);
  }
}
