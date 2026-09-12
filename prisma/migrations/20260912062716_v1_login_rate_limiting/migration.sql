-- CreateEnum
CREATE TYPE "LoginRateLimitBucket" AS ENUM ('ACCOUNT', 'NETWORK', 'ACCOUNT_NETWORK');

-- CreateTable
CREATE TABLE "login_rate_limits" (
    "id" TEXT NOT NULL,
    "bucket" "LoginRateLimitBucket" NOT NULL,
    "keyHash" TEXT NOT NULL,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "lockedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "login_rate_limits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "login_rate_limits_lockedUntil_idx" ON "login_rate_limits"("lockedUntil");

-- CreateIndex
CREATE UNIQUE INDEX "login_rate_limits_bucket_keyHash_key" ON "login_rate_limits"("bucket", "keyHash");
