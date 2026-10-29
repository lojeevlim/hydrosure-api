# Hydrosure API

REST API for Hydrosure, a point-of-sale and inventory app for a small store: products and catalog master
data, stock movements, POS sales with voids and receipts, and a dashboard. Money is handled in integer cents.

Stack: Node, Express 5, Prisma 6, PostgreSQL 16, Zod, JWT access tokens + rotating refresh tokens, Vitest/supertest.
The web client lives in a separate project (`hydrosure-app`).

## Prerequisites

- Node 22+ (developed on Node 25)
- Docker (for Postgres)

## Setup

```sh
npm install
cp .env.example .env
```

Edit `.env`:

- `JWT_ACCESS_SECRET`: 32+ random characters (for example `openssl rand -hex 32`). The API refuses to start otherwise.
- `SEED_ADMIN_PASSWORD`: a strong password you choose (the seed refuses weak ones): 12-72 characters with a lowercase letter, an uppercase letter, a digit and a symbol, and not containing "password". `SEED_ADMIN_EMAIL` is the admin login.
- `CORS_ORIGIN`: the exact origin the web app is served from.

Start the database, apply migrations, seed:

```sh
docker compose up -d db                 # Postgres 16 on localhost:5432 (named volume hydrosure_pgdata)
npm run prisma:deploy             # apply migrations
npm run seed                      # admin user + reference data (Piece unit, VAT 12% tax category, walk-in customer)
```

Optional demo data so the dashboard has charts (never runs in production, idempotent):

```sh
npm run seed:demo                 # 30 days of sales, DEMO- products, "Demo " categories/brands, stock movements
npm run seed:demo:clear           # deletes ONLY demo data
npm run seed:demo:clear -- --dry-run   # preview what clear would delete
```

Demo rows are identifiable by SKU prefix `DEMO-`, names starting `Demo `, and sale idempotency keys `demo-<date>-<n>`.

## Environment variables

| Variable | Default (.env.example) | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | `production` disables `/docs` and the demo seed |
| `PORT` | `4000` | HTTP port |
| `DATABASE_URL` | `postgresql://hydrosure:hydrosure@localhost:5432/hydrosure?schema=public` | Main database |
| `TEST_DATABASE_URL` | `.../hydrosure_test?schema=public` | Database used by the tests |
| `JWT_ACCESS_SECRET` | placeholder | Required, 32+ chars, unique random value in production |
| `ACCESS_TOKEN_TTL` | `15m` | Access token lifetime |
| `REFRESH_TOKEN_TTL_DAYS` | `7` | Refresh token lifetime |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed web origin(s), comma-separated. Must equal the web origin exactly |
| `AUTH_RATE_LIMIT_MAX` | `10` | Auth endpoint rate limit per window |
| `STORE_NAME` | `Lojee Store` | Store name on receipts |
| `CURRENCY_SYMBOL` | `PHP` | Currency label |
| `SEED_ADMIN_EMAIL` | `admin@example.com` | Admin login created by `seed` |
| `SEED_ADMIN_PASSWORD` | empty | Admin password for `seed` (12-72 chars, upper/lower/digit/symbol, no "password"); set before seeding |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `hydrosure` | Used by docker-compose |

## Running

```sh
npm run dev        # start db, migrate, seed, seed demo data, then tsx watch on port 4000
npm run dev:server # tsx watch only (db already running and seeded)
npm start      # tsx, no watch
```

`npm run dev` runs `docker compose up -d --wait db`, `prisma:deploy`, `seed`, `seed:demo` and then `dev:server`, so the setup steps above are done for you (Docker must be running and `.env` filled in). The seeds are idempotent. Log in with `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` from `.env`. Then start the web app (`hydrosure-app`) with `npm run dev` (http://localhost:5173).

`CORS_ORIGIN` must equal the exact origin the web app is served from (for example `http://localhost:5180` if the web
app runs on that port). Several origins can be comma-separated.

API docs (Swagger UI): `http://localhost:4000/docs` (disabled when `NODE_ENV=production`).

Full stack in Docker (db + api; set `JWT_ACCESS_SECRET` and `CORS_ORIGIN` in `.env` first):

```sh
docker compose up -d --build
```

The compose project is named `hydrosure` (volume `hydrosure_pgdata`).

## Tests and checks

```sh
npm test         # Vitest against the hydrosure_test database (Postgres must be up; migrations applied automatically)
npm run typecheck
```

## Roles

| Role | Can do |
|---|---|
| cashier | Sell at the POS, hold/resume own carts, view own sales and receipts, view products and master data. Product cost, wholesale price and sale item unit cost are hidden. Dashboard shows only own figures. |
| manager | Everything a cashier can, plus: create/edit/archive/delete products, manage master data (categories, brands, units, tags, suppliers, tax categories), stock receipts / opening balance / adjustments / write-offs, view stock and movements, view all sales, void sales. |
| admin | Same API permissions as manager today (the admin role exists for user-level administration; no admin-only endpoints yet). |

## Payments

Card and e-wallet payments are only recorded as unverified external references. There is no payment processor integration.

## Shared schemas

`src/shared` holds the Zod schemas and types used by both this API and the web client. The import specifier
`@hydrosure/shared` is mapped to `src/shared/index.ts` through `paths` in `tsconfig.json` and `resolve.alias` in
`vitest.config.ts` (tsx honours the tsconfig `paths`).

The API copy is the source of truth. The web project keeps its own copy, so after changing `src/shared` copy it over:

```sh
cp -R src/shared/. ../hydrosure-app/src/shared/
```

## Known limitations and deployment checklist

Not production-ready as shipped. Deferred items to resolve before a real deployment:

- [ ] Refresh token is stored in `localStorage` by the web client; move to an HttpOnly cookie.
- [ ] Rate limiting is in-memory per process; use a shared store (Redis) and set `TRUST_PROXY` correctly behind a proxy/load balancer.
- [ ] Harden `Dockerfile`: run as non-root, use a production build (it currently runs TypeScript via tsx), do not publish the DB port in `docker-compose.yml`, require a strong DB password (compose defaults to `hydrosure`/`hydrosure`).
- [ ] Add audit rows for product price/cost changes and archive/unarchive.
- [ ] Voiding a card/e-wallet sale needs a refund-pending state (the external payment is not reversed).
- [ ] Re-check product price and archived status under the row lock at checkout.
- [ ] Cashiers can read supplier contact fields.
- [ ] Change the seeded admin password after first login.
- [ ] `JWT_ACCESS_SECRET` must be a unique random value (the `.env.example` placeholder is rejected in production).
- [ ] Confirm `/docs` is disabled (`NODE_ENV=production`) and set `CORS_ORIGIN` to the real web origin.
