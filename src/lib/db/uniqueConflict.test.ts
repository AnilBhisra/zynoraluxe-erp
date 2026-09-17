import { describe, expect, it } from "vitest";

import { Prisma } from "@/generated/prisma/client";

import { isIdempotencyConflict, isUniqueConflictOn } from "./uniqueConflict";

function p2002(meta: Record<string, unknown> | undefined) {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test", meta });
}

// Exactly what @prisma/adapter-pg produced on the real PostgreSQL 17 test
// database when two submissions raced with one idempotency key.
function adapterConflict(index: string, table = "vouchers") {
  return p2002({
    driverAdapterError: {
      name: "DriverAdapterError",
      cause: { originalCode: "23505", kind: "UniqueConstraintViolation", constraint: { index }, table },
    },
    modelName: "Voucher",
  });
}

describe("isIdempotencyConflict", () => {
  it("recognises the driver adapter's constraint name (the shape a real database returns)", () => {
    expect(isIdempotencyConflict(adapterConflict("vouchers_idempotencyKey_key"))).toBe(true);
    expect(isIdempotencyConflict(adapterConflict("packet_process_jobs_idempotencyKey_key", "packet_process_jobs"))).toBe(true);
  });

  it("recognises the driver adapter's field list", () => {
    expect(
      isIdempotencyConflict(p2002({ driverAdapterError: { cause: { kind: "UniqueConstraintViolation", constraint: { fields: ["idempotencyKey"] } } } }))
    ).toBe(true);
  });

  it("still recognises the classic meta.target column list", () => {
    expect(isIdempotencyConflict(p2002({ target: ["idempotencyKey"] }))).toBe(true);
  });

  it("does not treat other unique violations as an idempotent duplicate", () => {
    expect(isIdempotencyConflict(adapterConflict("polished_purchases_voucherId_key"))).toBe(false);
    expect(isIdempotencyConflict(adapterConflict("vouchers_voucherNumber_key"))).toBe(false);
    expect(isIdempotencyConflict(p2002({ target: ["voucherNumber"] }))).toBe(false);
    expect(isIdempotencyConflict(p2002(undefined))).toBe(false);
  });

  it("ignores other error codes and non-Prisma errors", () => {
    expect(
      isIdempotencyConflict(new Prisma.PrismaClientKnownRequestError("x", { code: "P2025", clientVersion: "test", meta: { target: ["idempotencyKey"] } }))
    ).toBe(false);
    expect(isIdempotencyConflict(new Error("idempotencyKey"))).toBe(false);
    expect(isIdempotencyConflict(null)).toBe(false);
  });

  it("matches whole column names only", () => {
    expect(isUniqueConflictOn(adapterConflict("diamond_processes_name_key"), "name")).toBe(true);
    expect(isUniqueConflictOn(adapterConflict("diamond_processes_name_key"), "nam")).toBe(false);
  });
});
