import { z } from 'zod';
import { paginationQuerySchema } from '../../common/pagination';

export const orderParams = z.object({ orderId: z.uuid() });

export const placeOrderBody = z.object({
  customerEmail: z
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  paymentToken: z.string().min(1).max(100),
  items: z
    .array(z.object({ productId: z.uuid(), quantity: z.number().int().min(1).max(100) }))
    .min(1)
    .max(50)
    .refine(
      (items) => new Set(items.map((i) => i.productId)).size === items.length,
      'each product may appear only once',
    ),
});

export const listOrdersQuery = paginationQuerySchema.extend({
  status: z
    .enum(['PENDING', 'STOCK_RESERVED', 'PAID', 'CONFIRMED', 'COMPENSATING', 'CANCELLED'])
    .optional(),
});

export type OrderParams = z.infer<typeof orderParams>;
export type PlaceOrderInput = z.infer<typeof placeOrderBody>;
export type ListOrdersQuery = z.infer<typeof listOrdersQuery>;
