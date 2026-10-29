-- Idempotency keys are now scoped per cashier (no cross-user collisions/leaks)
-- and carry a request fingerprint. Existing rows keep their keys; fingerprint stays NULL.
ALTER TABLE "Sale" ADD COLUMN "idempotencyFingerprint" TEXT;

-- Global uniqueness is replaced by the strictly weaker per-cashier uniqueness, so no existing row can violate it.
DROP INDEX "Sale_idempotencyKey_key";
CREATE UNIQUE INDEX "Sale_cashierId_idempotencyKey_key" ON "Sale"("cashierId", "idempotencyKey");
