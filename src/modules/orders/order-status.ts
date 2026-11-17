import { AppError } from '../../common/errors';
import type { OrderStatus } from '../../generated/prisma/client';

/**
 * State machine: an order has a real lifecycle, so every allowed move is listed here and any
 * other move is rejected. COMPENSATING means a step failed and the saga is undoing earlier steps.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ['STOCK_RESERVED', 'CANCELLED'],
  STOCK_RESERVED: ['PAID', 'COMPENSATING'],
  PAID: ['CONFIRMED', 'COMPENSATING'],
  COMPENSATING: ['CANCELLED'],
  CONFIRMED: [],
  CANCELLED: [],
};

export class InvalidTransitionError extends AppError {
  constructor(from: OrderStatus, to: OrderStatus) {
    super(409, 'INVALID_TRANSITION', `Order cannot move from ${from} to ${to}`);
  }
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** Why a cancelled order was cancelled. */
export type FailureReason = 'OUT_OF_STOCK' | 'PAYMENT_DECLINED' | 'RESERVATION_EXPIRED';
