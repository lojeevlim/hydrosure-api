const bearer = [{ bearerAuth: [] }];
const op = (summary: string, extra: Record<string, unknown> = {}) => ({
  summary,
  security: bearer,
  responses: { '200': { description: 'OK' }, '400': { description: 'Validation error' }, '401': { description: 'Unauthorized' } },
  ...extra,
});
const crudPaths = (base: string, tag: string) => ({
  [base]: { get: op(`List ${tag}`, { tags: [tag] }), post: op(`Create ${tag} (manager+)`, { tags: [tag] }) },
  [`${base}/{id}`]: {
    get: op(`Get ${tag}`, { tags: [tag] }),
    patch: op(`Update ${tag} (manager+)`, { tags: [tag] }),
    delete: op(`Delete ${tag} (manager+, 409 if in use)`, { tags: [tag] }),
  },
});

export const openApiSpec = {
  openapi: '3.0.3',
  info: { title: 'Hydrosure POS API', version: '0.1.0', description: 'Phase 1 POS / inventory API. Request schemas live in @hydrosure/shared (zod).' },
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
  paths: {
    '/api/auth/login': { post: { tags: ['auth'], summary: 'Login (rate limited)', responses: { '200': { description: 'Access + refresh tokens' }, '401': { description: 'Invalid credentials' } } } },
    '/api/auth/google': { post: { tags: ['auth'], summary: 'Sign in with a Google ID token (rate limited). Admin accounts only; links an existing admin by email, never creates users', responses: { '200': { description: 'Access + refresh tokens' }, '401': { description: 'Invalid Google token' }, '403': { description: 'Email unverified, not an admin account, or account inactive' } } } },
    '/api/auth/refresh': { post: { tags: ['auth'], summary: 'Rotate refresh token (reuse revokes the family)', responses: { '200': { description: 'New tokens' }, '401': { description: 'Invalid/reused token' } } } },
    '/api/auth/logout': { post: { tags: ['auth'], summary: 'Revoke refresh token family', responses: { '204': { description: 'Done' } } } },
    '/api/auth/me': { get: op('Current user', { tags: ['auth'] }) },
    '/api/products': { get: op('List/search/filter products (search, barcode, categoryId, brandId, supplierId, tagId, archived, stock=low|out, sortBy, sortDir, page, pageSize)', { tags: ['products'] }), post: op('Create product (manager+); openingQty creates an opening_balance movement', { tags: ['products'] }) },
    '/api/products/{id}': { get: op('Get product', { tags: ['products'] }), patch: op('Update product (manager+, stock not editable)', { tags: ['products'] }), delete: op('Archive product (soft delete)', { tags: ['products'] }) },
    '/api/products/{id}/archive': { post: op('Archive (manager+)', { tags: ['products'] }) },
    '/api/products/{id}/unarchive': { post: op('Unarchive (manager+)', { tags: ['products'] }) },
    ...crudPaths('/api/categories', 'categories'),
    ...crudPaths('/api/brands', 'brands'),
    ...crudPaths('/api/units', 'units'),
    ...crudPaths('/api/tags', 'tags'),
    ...crudPaths('/api/suppliers', 'suppliers'),
    ...crudPaths('/api/tax-categories', 'tax-categories'),
    '/api/inventory/movements': { get: op('Movement history (productId, type, from/to inclusive dates)', { tags: ['inventory'] }) },
    '/api/inventory/stock': { get: op('Low / out-of-stock products (status=low|out)', { tags: ['inventory'] }) },
    '/api/inventory/receipts': { post: op('Receive stock (manager+)', { tags: ['inventory'] }) },
    '/api/inventory/opening-balance': { post: op('Opening balance (manager+)', { tags: ['inventory'] }) },
    '/api/inventory/adjustments': { post: op('Signed adjustment with reason (manager+)', { tags: ['inventory'] }) },
    '/api/inventory/write-offs': { post: op('Damage / waste (manager+)', { tags: ['inventory'] }) },
    '/api/sales': { post: op('Checkout: server-priced, single transaction, idempotent on idempotencyKey (201 new, 200 replay, 409 insufficient stock)', { tags: ['sales'] }), get: op('List sales', { tags: ['sales'] }) },
    '/api/sales/{id}': { get: op('Get sale', { tags: ['sales'] }) },
    '/api/sales/{id}/receipt': { get: op('Receipt data', { tags: ['sales'] }) },
    '/api/sales/{id}/void': { post: op('Void sale (manager+): reverses stock, writes AuditLog', { tags: ['sales'] }) },
    '/api/dashboard': { get: op('Dashboard aggregates for ?from=&to= (ISO; tz=IANA zone for day buckets). Completed sales only; previous period = same length immediately before. Cashiers get own-sales totals only (no profit, valuation or movements)', { tags: ['dashboard'] }) },
    '/api/held-carts': { get: op('List held carts', { tags: ['held-carts'] }), post: op('Hold cart', { tags: ['held-carts'] }) },
    '/api/held-carts/{id}/resume': { post: op('Resume (returns cart and removes hold)', { tags: ['held-carts'] }) },
    '/api/held-carts/{id}': { delete: op('Discard held cart', { tags: ['held-carts'] }) },
  },
};
