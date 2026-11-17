import type { EventHandlers } from '../events/event-consumer';
import type { InventoryService } from './inventory.service';

export const INVENTORY_CONSUMER = 'inventory';

/** The commands the inventory consumer reacts to. */
export function inventoryHandlers(service: InventoryService): EventHandlers {
  return {
    'inventory.reserve-requested': (tx, payload) => service.reserve(tx, payload),
    'inventory.commit-requested': (tx, { orderId }) => service.commit(tx, orderId),
    'inventory.release-requested': (tx, { orderId }) => service.release(tx, orderId),
  };
}
