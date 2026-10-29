import { z } from 'zod';
import { MAX_MONEY, MAX_QTY, paginationQuerySchema } from './common';
import { dateOnlySchema } from './catalog';

export const movementTypeSchema = z.enum([
  'opening_balance',
  'receipt',
  'adjustment',
  'damage',
  'waste',
  'sale',
  'void_return',
]);
export type MovementType = z.infer<typeof movementTypeSchema>;

const productId = z.string().min(1);
const posQty = z.number().int().positive().max(MAX_QTY);

export const receiptInputSchema = z.object({
  productId,
  qty: posQty,
  unitCost: z.number().nonnegative().max(MAX_MONEY).optional(),
  supplierId: z.string().nullish(),
  reason: z.string().trim().max(300).optional(),
});
export const openingBalanceInputSchema = z.object({
  productId,
  qty: z.number().int().min(0).max(MAX_QTY),
  reason: z.string().trim().max(300).optional(),
});
/** qtyChange is signed; reason is mandatory for adjustments. */
export const adjustmentInputSchema = z.object({
  productId,
  qtyChange: z.number().int().min(-MAX_QTY).max(MAX_QTY).refine((n) => n !== 0, 'qtyChange must not be 0'),
  reason: z.string().trim().min(1).max(300),
});
export const writeOffInputSchema = z.object({
  productId,
  type: z.enum(['damage', 'waste']),
  qty: posQty,
  reason: z.string().trim().min(1).max(300),
});
export type ReceiptInput = z.infer<typeof receiptInputSchema>;
export type OpeningBalanceInput = z.infer<typeof openingBalanceInputSchema>;
export type AdjustmentInput = z.infer<typeof adjustmentInputSchema>;
export type WriteOffInput = z.infer<typeof writeOffInputSchema>;

const dateBoundSchema = z.union([
  dateOnlySchema,
  z.iso.datetime({ offset: true }),
]);

export const movementListQuerySchema = paginationQuerySchema.extend({
  productId: z.string().optional(),
  type: movementTypeSchema.optional(),
  /** Inclusive range, YYYY-MM-DD (UTC days) or a full ISO timestamp. */
  from: dateBoundSchema.optional(),
  to: dateBoundSchema.optional(),
}).refine((q) => !q.from || !q.to || new Date(q.from) <= new Date(q.to), { path: ['to'], message: '"to" must not be before "from"' });
export type MovementListQuery = z.infer<typeof movementListQuerySchema>;

export const stockListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['low', 'out']).default('low'),
});
