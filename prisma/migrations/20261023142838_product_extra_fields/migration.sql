-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "expirationDate" DATE,
ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "maxStock" INTEGER,
ADD COLUMN     "wholesalePrice" DECIMAL(12,2);
