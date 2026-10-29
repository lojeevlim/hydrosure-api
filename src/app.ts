import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { Prisma } from '@prisma/client';
import { config } from './config';
import { errorHandler, notFoundHandler } from './middleware/error';
import { authRouter } from './routes/auth';
import { productsRouter } from './routes/products';
import {
  brandsRouter,
  categoriesRouter,
  suppliersRouter,
  taxCategoriesRouter,
  tagsRouter,
  unitsRouter,
} from './routes/masterdata';
import { inventoryRouter } from './routes/inventory';
import { salesRouter } from './routes/sales';
import { heldCartsRouter } from './routes/heldCarts';
import { dashboardRouter } from './routes/dashboard';
import { openApiSpec } from './openapi';
import { prisma } from './db';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Only trust proxy headers when explicitly configured (affects req.ip / rate limiting).
  if (config.TRUST_PROXY !== undefined) app.set('trust proxy', config.TRUST_PROXY);
  // Serialize Prisma Decimals as JSON numbers rather than strings.
  app.set('json replacer', function (this: Record<string, unknown>, key: string, value: unknown) {
    const raw = this[key];
    return raw instanceof Prisma.Decimal ? raw.toNumber() : value;
  });

  // Swagger UI needs inline scripts/styles, so it is mounted before strict helmet CSP.
  if (config.NODE_ENV !== 'production') {
    app.use('/docs', helmet({ contentSecurityPolicy: false }), swaggerUi.serve, swaggerUi.setup(openApiSpec));
  }
  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean), credentials: true }));
  app.use(express.json({ limit: '256kb' }));

  // Liveness + database check: 200 when the API can reach Postgres, 503 otherwise (used by the Docker healthcheck).
  app.get('/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', db: 'up' });
    } catch {
      res.status(503).json({ status: 'error', db: 'down' });
    }
  });
  app.use('/api/auth', authRouter);
  app.use('/api/products', productsRouter);
  app.use('/api/categories', categoriesRouter);
  app.use('/api/brands', brandsRouter);
  app.use('/api/units', unitsRouter);
  app.use('/api/tags', tagsRouter);
  app.use('/api/suppliers', suppliersRouter);
  app.use('/api/tax-categories', taxCategoriesRouter);
  app.use('/api/inventory', inventoryRouter);
  app.use('/api/sales', salesRouter);
  app.use('/api/held-carts', heldCartsRouter);
  app.use('/api/dashboard', dashboardRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
