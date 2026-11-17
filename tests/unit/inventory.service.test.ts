import type { Db } from '../../src/common/db';
import type { StockReservation } from '../../src/generated/prisma/client';
import type { OutboxRepository } from '../../src/modules/events/events.repository';
import type { ReservationRepository } from '../../src/modules/inventory/inventory.repository';
import { InventoryService } from '../../src/modules/inventory/inventory.service';
import { fakeDbContext, mockOf } from './fakes';

const tx = {} as Db;
const orderId = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function reservation(overrides: Partial<StockReservation> = {}): StockReservation {
  return {
    id: 'r1',
    orderId,
    productId: A,
    quantity: 1,
    status: 'RESERVED',
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('InventoryService', () => {
  let reservations: jest.Mocked<ReservationRepository>;
  let outbox: jest.Mocked<OutboxRepository>;
  let service: InventoryService;

  beforeEach(() => {
    reservations = mockOf<ReservationRepository>(
      'takeStock',
      'returnStock',
      'createMany',
      'findByOrder',
      'setStatus',
    );
    outbox = mockOf<OutboxRepository>('append');
    service = new InventoryService(fakeDbContext(), reservations, outbox, 300);
  });

  it('takes stock in product id order and records the reservation', async () => {
    reservations.takeStock.mockResolvedValue(true);
    await service.reserve(tx, {
      orderId,
      items: [
        { productId: B, quantity: 1 },
        { productId: A, quantity: 2 },
      ],
    });
    expect(reservations.takeStock.mock.calls.map((c) => c[1])).toEqual([A, B]);
    expect(reservations.createMany).toHaveBeenCalled();
    expect(outbox.append).toHaveBeenCalledWith(tx, 'inventory.stock-reserved', orderId, {
      orderId,
    });
  });

  it('gives back what it took when a later item is out of stock', async () => {
    reservations.takeStock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await service.reserve(tx, {
      orderId,
      items: [
        { productId: A, quantity: 2 },
        { productId: B, quantity: 5 },
      ],
    });
    expect(reservations.returnStock).toHaveBeenCalledWith(tx, A, 2);
    expect(reservations.createMany).not.toHaveBeenCalled();
    expect(outbox.append).toHaveBeenCalledWith(tx, 'inventory.reservation-failed', orderId, {
      orderId,
      reason: 'OUT_OF_STOCK',
    });
  });

  it('refuses to commit an expired hold', async () => {
    reservations.findByOrder.mockResolvedValue([
      reservation({ expiresAt: new Date(Date.now() - 1) }),
    ]);
    await service.commit(tx, orderId);
    expect(reservations.setStatus).not.toHaveBeenCalled();
    expect(outbox.append).toHaveBeenCalledWith(tx, 'inventory.commit-failed', orderId, {
      orderId,
      reason: 'RESERVATION_EXPIRED',
    });
  });

  it('releases only rows that are still held', async () => {
    reservations.findByOrder.mockResolvedValue([
      reservation({ id: 'r1', productId: A, quantity: 2 }),
      reservation({ id: 'r2', productId: B, status: 'RELEASED' }),
    ]);
    await service.release(tx, orderId);
    expect(reservations.returnStock).toHaveBeenCalledTimes(1);
    expect(reservations.returnStock).toHaveBeenCalledWith(tx, A, 2);
    expect(reservations.setStatus).toHaveBeenCalledWith(tx, ['r1'], 'RELEASED');
  });
});
