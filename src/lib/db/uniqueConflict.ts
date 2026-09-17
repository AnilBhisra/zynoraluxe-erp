import { Prisma } from "@/generated/prisma/client";

/**
 * True when `error` is a unique-constraint violation (P2002) on `column`.
 *
 * The shape of P2002 metadata depends on the engine. The classic query engine
 * reports `meta.target` (the column list, or the constraint name). The
 * `@prisma/adapter-pg` driver adapter this app runs on reports only
 * `meta.driverAdapterError.cause.constraint`, which holds either `fields` or
 * the Postgres constraint name as `index` (for example
 * `vouchers_idempotencyKey_key`). Checking `meta.target` alone never matched
 * on a real database, so a lost double-submit race surfaced as an error
 * instead of returning the record the winning request saved.
 */
export function isUniqueConflictOn(error: unknown, column: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  const meta = (error.meta ?? {}) as Record<string, unknown>;
  const namesColumn = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some((v) => v === column);
    if (typeof value !== "string") return false;
    return value === column || value.split("_").includes(column);
  };

  if (namesColumn(meta.target)) return true;

  const adapterError = meta.driverAdapterError as { cause?: { constraint?: { fields?: unknown; index?: unknown } } } | undefined;
  const constraint = adapterError?.cause?.constraint;
  return Boolean(constraint && (namesColumn(constraint.fields) || namesColumn(constraint.index)));
}

export function isIdempotencyConflict(error: unknown): boolean {
  return isUniqueConflictOn(error, "idempotencyKey");
}
