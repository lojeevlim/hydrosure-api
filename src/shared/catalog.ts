import { z } from 'zod';
import { MAX_QTY, moneySchema, paginationQuerySchema } from './common';

const name = z.string().trim().min(1).max(120);
const optionalText = (max = 200) => z.string().trim().max(max).nullish();

export const categoryInputSchema = z.object({ name, parentId: z.string().nullish() });
export const brandInputSchema = z.object({ name });
export const unitInputSchema = z.object({ name, abbreviation: z.string().trim().min(1).max(12) });
export const tagInputSchema = z.object({ name });
export const supplierInputSchema = z.object({
  name,
  contactName: optionalText(),
  email: z.union([z.email(), z.literal('')]).nullish(),
  phone: optionalText(40),
  address: optionalText(300),
});
/** Percent, 0-100 with at most 2 decimals. Accepts numeric strings from form inputs. */
export const taxCategoryInputSchema = z.object({
  name,
  rate: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v),
    z.number().finite().min(0, 'Must be 0 or more').max(100, 'Must be 100 or less').multipleOf(0.01, 'Use at most 2 decimal places'),
  ),
});
export type TaxCategoryInput = z.infer<typeof taxCategoryInputSchema>;
export type CategoryInput = z.infer<typeof categoryInputSchema>;
export type BrandInput = z.infer<typeof brandInputSchema>;
export type UnitInput = z.infer<typeof unitInputSchema>;
export type TagInput = z.infer<typeof tagInputSchema>;
export type SupplierInput = z.infer<typeof supplierInputSchema>;

/** Strict http(s) URL; rejects javascript:, data: and every other scheme. */
export const imageUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
    } catch {
      return false;
    }
  }, 'Must be a valid http(s) URL');

/** Calendar date as YYYY-MM-DD. */
export const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Not a valid date');

export const productBaseSchema = z.object({
  sku: z.string().trim().min(1).max(64),
  barcode: z.string().trim().min(1).max(64).nullish(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullish(),
  categoryId: z.string().nullish(),
  brandId: z.string().nullish(),
  unitId: z.string().nullish(),
  supplierId: z.string().nullish(),
  taxCategoryId: z.string().nullish(),
  cost: moneySchema.default(0),
  price: moneySchema,
  wholesalePrice: moneySchema.nullish(),
  reorderLevel: z.number().int().min(0).max(2_147_483_647).default(0),
  maxStock: z.number().int().min(0).max(2_147_483_647).nullish(),
  expirationDate: dateOnlySchema.nullish(),
  imageUrl: imageUrlSchema.nullish(),
  tagIds: z.array(z.string()).default([]),
});

const maxStockCheck = (
  v: { maxStock?: number | null; reorderLevel?: number },
  ctx: z.RefinementCtx,
) => {
  if (v.maxStock != null && v.reorderLevel != null && v.maxStock < v.reorderLevel) {
    ctx.addIssue({ code: 'custom', path: ['maxStock'], message: 'Max stock must be at least the reorder level' });
  }
};

export const productCreateSchema = productBaseSchema
  .extend({
    /** Optional opening stock, recorded as an opening_balance movement. */
    openingQty: z.number().int().min(0).max(MAX_QTY).default(0),
  })
  .superRefine(maxStockCheck);
export type ProductCreateInput = z.infer<typeof productCreateSchema>;

/** Stock is never editable here; use inventory movements. */
export const productUpdateSchema = productBaseSchema
  .partial()
  // partial() keeps .default(), which would silently reset cost/reorderLevel/tags on a partial PATCH.
  .extend({
    cost: moneySchema.optional(),
    reorderLevel: z.number().int().min(0).max(2_147_483_647).optional(),
    tagIds: z.array(z.string()).optional(),
  })
  .superRefine(maxStockCheck);
export type ProductUpdateInput = z.infer<typeof productUpdateSchema>;

const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true');

export const productListQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().optional(),
  barcode: z.string().trim().optional(),
  categoryId: z.string().optional(),
  brandId: z.string().optional(),
  supplierId: z.string().optional(),
  tagId: z.string().optional(),
  archived: boolQuery.default(false),
  stock: z.enum(['low', 'out']).optional(),
  sortBy: z.enum(['name', 'sku', 'price', 'stockQty', 'createdAt']).default('name'),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
});
export type ProductListQuery = z.infer<typeof productListQuerySchema>;
