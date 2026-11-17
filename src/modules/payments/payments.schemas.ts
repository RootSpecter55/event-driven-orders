import { z } from 'zod';
import { paginationQuerySchema } from '../../common/pagination';

export const listPaymentsQuery = paginationQuerySchema.extend({ orderId: z.uuid().optional() });

export type ListPaymentsQuery = z.infer<typeof listPaymentsQuery>;
