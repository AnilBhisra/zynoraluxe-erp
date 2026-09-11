import { Prisma } from "@/generated/prisma/client";

/**
 * All money math in this app goes through Prisma's own Decimal (decimal.js
 * under the hood) — never JavaScript floating point — so that values
 * round-trip exactly with what is stored in Postgres NUMERIC columns.
 */
export const Decimal = Prisma.Decimal;
export type Decimal = Prisma.Decimal;

/**
 * decimal.js's own `Decimal.Value` union type doesn't survive Prisma's
 * re-export (a class-and-namespace merge collapses to just the instance
 * type across a `type X = Y` alias boundary). This covers every shape we
 * actually pass in — Decimal.js's internal `{s,e,d}` object form is never
 * used here.
 */
export type DecimalInput = string | number | Decimal;

export function toDecimal(value: DecimalInput): Decimal {
  return new Decimal(value);
}

/** Rounds to 2 decimal places using round-half-up, the standard rule for money. */
export function round2(value: DecimalInput): Decimal {
  return new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function isPositive(value: DecimalInput): boolean {
  return new Decimal(value).greaterThan(0);
}

export function isZero(value: DecimalInput): boolean {
  return new Decimal(value).isZero();
}

export const ZERO = new Decimal(0);
