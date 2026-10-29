import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(7),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
  /** Optional: hop count (e.g. 1), boolean, or comma-separated subnets. Unset = do not trust proxies. */
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v): number | boolean | string | undefined => {
      if (v === undefined || v.trim() === '') return undefined;
      const t = v.trim();
      if (t === 'true') return true;
      if (t === 'false') return false;
      return /^\d+$/.test(t) ? Number(t) : t;
    }),
  GOOGLE_CLIENT_ID: z.string().optional(),
  STORE_NAME: z.string().default('Lojee Store'),
  CURRENCY_SYMBOL: z.string().default('PHP'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

// Placeholder secrets shipped in .env.example must never run in production.
const PLACEHOLDER_SECRETS = ['change-me-to-a-long-random-string-of-32-plus-chars'];
if (
  parsed.data.NODE_ENV === 'production' &&
  PLACEHOLDER_SECRETS.some((p) => parsed.data.JWT_ACCESS_SECRET.includes(p) || /^change-?me/i.test(parsed.data.JWT_ACCESS_SECRET))
) {
  console.error('Invalid environment configuration:\n  JWT_ACCESS_SECRET: placeholder value is not allowed in production');
  process.exit(1);
}

if (
  parsed.data.NODE_ENV === 'production' &&
  (!parsed.data.GOOGLE_CLIENT_ID || parsed.data.GOOGLE_CLIENT_ID.startsWith('your-client-id'))
) {
  console.error('Invalid environment configuration:\n  GOOGLE_CLIENT_ID: required (non-placeholder) in production');
  process.exit(1);
}

export const config = parsed.data;
