import { z } from 'zod';
import { paginationQuerySchema } from '../../common/pagination';

export const listOutboxQuery = paginationQuerySchema.extend({
  published: z.enum(['true', 'false']).optional(),
});

export const listDeadLettersQuery = paginationQuerySchema.extend({
  consumer: z.string().min(1).max(100).optional(),
});

export const deadLetterParams = z.object({ deadLetterId: z.uuid() });

export type ListOutboxQuery = z.infer<typeof listOutboxQuery>;
export type ListDeadLettersQuery = z.infer<typeof listDeadLettersQuery>;
export type DeadLetterParams = z.infer<typeof deadLetterParams>;
