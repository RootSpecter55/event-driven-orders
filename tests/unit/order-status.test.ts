import type { OrderStatus } from '../../src/generated/prisma/client';
import {
  assertTransition,
  canTransition,
  InvalidTransitionError,
  ORDER_TRANSITIONS,
} from '../../src/modules/orders/order-status';

const ALL = Object.keys(ORDER_TRANSITIONS) as OrderStatus[];

describe('order state machine', () => {
  it('allows exactly the transitions in the table and nothing else', () => {
    const allowed = ALL.flatMap((from) =>
      ALL.filter((to) => canTransition(from, to)).map((to) => `${from}->${to}`),
    );
    expect(allowed.sort()).toEqual(
      [
        'PENDING->STOCK_RESERVED',
        'PENDING->CANCELLED',
        'STOCK_RESERVED->PAID',
        'STOCK_RESERVED->COMPENSATING',
        'PAID->CONFIRMED',
        'PAID->COMPENSATING',
        'COMPENSATING->CANCELLED',
      ].sort(),
    );
  });

  it('treats CONFIRMED and CANCELLED as final', () => {
    expect(ORDER_TRANSITIONS.CONFIRMED).toEqual([]);
    expect(ORDER_TRANSITIONS.CANCELLED).toEqual([]);
  });

  it('throws a 409 InvalidTransitionError for a disallowed move', () => {
    expect(() => assertTransition('CONFIRMED', 'CANCELLED')).toThrow(InvalidTransitionError);
    expect(() => assertTransition('PENDING', 'PAID')).toThrow(
      'Order cannot move from PENDING to PAID',
    );
    expect(() => assertTransition('PAID', 'CONFIRMED')).not.toThrow();
  });
});
