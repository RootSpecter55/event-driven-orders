import { z } from 'zod';
import { paginationQuerySchema } from '../../common/pagination';

export const productParams = z.object({ productId: z.uuid() });

export const createProductBody = z.object({
  sku: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9-]+$/, 'letters, digits and dashes only'),
  name: z.string().trim().min(1).max(200),
  priceCents: z.number().int().positive().max(100_000_000),
  stock: z.number().int().min(0).max(1_000_000),
});

export const updateProductBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    priceCents: z.number().int().positive().max(100_000_000),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'at least one field is required');

export const restockBody = z.object({ quantity: z.number().int().positive().max(1_000_000) });

export const listProductsQuery = paginationQuerySchema;

export type ProductParams = z.infer<typeof productParams>;
export type CreateProductInput = z.infer<typeof createProductBody>;
export type UpdateProductInput = z.infer<typeof updateProductBody>;
export type RestockInput = z.infer<typeof restockBody>;
export type ListProductsQuery = z.infer<typeof listProductsQuery>;
