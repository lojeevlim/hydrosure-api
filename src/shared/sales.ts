import { z } from 'zod';
import { moneySchema, paginationQuerySchema, qtySchema } from './common';

export const discountSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('percent'), value: z.number().min(0).max(100) }),
  z.object({ type: z.literal('fixed'), value: moneySchema }),
]);
export type DiscountInput = z.infer<typeof discountSchema>;

/**
 * Cart lines carry only product id, quantity and discount. Prices, cost and
 * tax are always resolved server-side; any client price is ignored.
 */
export const cartItemSchema = z.object({
  productId: z.string().min(1),
  qty: qtySchema,
  discount: discountSchema.optional(),
});
export type CartItemInput = z.infer<typeof cartItemSchema>;

export const paymentMethodSchema = z.enum(['cash', 'card', 'ewallet']);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

/**
 * cash: `amount` is the cash tendered; change is computed server-side.
 * card/ewallet: recorded as an unverified external reference (not processed by us).
 */
export const paymentInputSchema = z
  .object({
    method: paymentMethodSchema,
    amount: moneySchema,
    externalRef: z.string().trim().min(1).max(120).optional(),
  })
  .refine((p) => p.method === 'cash' || !!p.externalRef, {
    message: 'externalRef is required for card/ewallet payments',
    path: ['externalRef'],
  });
export type PaymentInput = z.infer<typeof paymentInputSchema>;

export const checkoutSchema = z.object({
  idempotencyKey: z.string().min(8).max(100),
  customerId: z.string().nullish(),
  items: z.array(cartItemSchema).min(1).max(200),
  payment: paymentInputSchema,
});
export type CheckoutInput = z.infer<typeof checkoutSchema>;

export const voidSaleSchema = z.object({ reason: z.string().trim().min(1).max(300) });
export type VoidSaleInput = z.infer<typeof voidSaleSchema>;

export const saleListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['completed', 'voided']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type SaleListQuery = z.infer<typeof saleListQuerySchema>;

export const heldCartInputSchema = z.object({
  label: z.string().trim().max(80).optional(),
  customerId: z.string().nullish(),
  items: z.array(cartItemSchema).min(1).max(200),
});
export type HeldCartInput = z.infer<typeof heldCartInputSchema>;
