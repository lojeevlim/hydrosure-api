import { z } from 'zod';

export const idSchema = z.string().min(1);
/** Upper bounds keep values inside DB column ranges (Decimal(12,2), Int4). */
export const MAX_MONEY = 9_999_999.99;
export const MAX_QTY = 100_000;
export const moneySchema = z.number().finite().nonnegative().max(MAX_MONEY).multipleOf(0.01);
export const qtySchema = z.number().int().positive().max(MAX_QTY);

export const roleSchema = z.enum(['admin', 'manager', 'cashier']);
export type Role = z.infer<typeof roleSchema>;

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
