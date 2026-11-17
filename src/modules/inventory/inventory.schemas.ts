import { z } from 'zod';
import { paginationQuerySchema } from '../../common/pagination';

export const listReservationsQuery = paginationQuerySchema.extend({
  orderId: z.uuid().optional(),
});

export type ListReservationsQuery = z.infer<typeof listReservationsQuery>;
