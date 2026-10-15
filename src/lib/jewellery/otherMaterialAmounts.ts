/**
 * Other Material purchase line amounts — EXACT decimal arithmetic on BigInt
 * (no floating point), shared by the browser preview and the server, so the
 * amount the user sees is the amount that posts. The server never trusts an
 * amount sent by the browser: it recomputes it from quantity × rate.
 *
 *   Base amount   = quantity × rate per unit           (rounded to the paisa, half-up)
 *   Taxable value = base − discount                     (GST exclusive)
 *                 = (base − discount) × 100 / (100 + GST%)   (GST inclusive)
 *   GST           = taxable × GST% / 100 (exclusive) or the inclusive remainder
 *   Line total    = taxable + GST
 */

export const QTY_DP = 3;
export const RATE_DP = 4;
export const MONEY_DP = 2;

export type UnitCode = "PCS" | "CT" | "GRAM" | "OTHER";
export const UNIT_RATE_LABEL: Record<UnitCode, string> = { PCS: "₹ per PCS", CT: "₹ per CT", GRAM: "₹ per GRAM", OTHER: "₹ per unit" };

type Fixed = { v: bigint; dp: number };

/** "200", "12.5", "0.125" → exact fixed-point; null when blank / not a plain non-negative number / too many decimals. */
export function parseFixed(text: string | number | null | undefined, maxDp: number): Fixed | null {
  const t = String(text ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [int, frac = ""] = t.split(".");
  if (frac.length > maxDp) return null;
  return { v: BigInt(int + frac.padEnd(maxDp, "0")), dp: maxDp };
}

const pow10 = (n: number) => BigInt(10) ** BigInt(n);

/** Round a fixed value to `dp` decimals, half-up (all values here are non-negative). */
function roundTo(x: Fixed, dp: number): Fixed {
  if (x.dp <= dp) return { v: x.v * pow10(dp - x.dp), dp };
  const drop = pow10(x.dp - dp);
  const q = x.v / drop;
  const r = x.v % drop;
  return { v: r * BigInt(2) >= drop ? q + BigInt(1) : q, dp };
}
function mul(a: Fixed, b: Fixed): Fixed {
  return { v: a.v * b.v, dp: a.dp + b.dp };
}
function align(a: Fixed, b: Fixed): [bigint, bigint, number] {
  const dp = Math.max(a.dp, b.dp);
  return [a.v * pow10(dp - a.dp), b.v * pow10(dp - b.dp), dp];
}
function sub(a: Fixed, b: Fixed): Fixed {
  const [x, y, dp] = align(a, b);
  return { v: x - y, dp };
}
function add(a: Fixed, b: Fixed): Fixed {
  const [x, y, dp] = align(a, b);
  return { v: x + y, dp };
}
/** a × num / den rounded half-up to `dp` (non-negative). */
function mulDiv(a: Fixed, num: Fixed, den: Fixed, dp: number): Fixed {
  // value = a.v·num.v / (den.v) · 10^(den.dp − a.dp − num.dp); scale to dp with one extra digit for rounding.
  const shift = dp + den.dp - a.dp - num.dp;
  let n = a.v * num.v;
  let d = den.v;
  if (shift >= 0) n *= pow10(shift);
  else d *= pow10(-shift);
  const q = n / d;
  const r = n % d;
  return { v: r * BigInt(2) >= d ? q + BigInt(1) : q, dp };
}

export function formatFixed(x: Fixed): string {
  const neg = x.v < BigInt(0);
  const s = (neg ? -x.v : x.v).toString().padStart(x.dp + 1, "0");
  const out = x.dp === 0 ? s : `${s.slice(0, -x.dp)}.${s.slice(-x.dp)}`;
  return neg ? `-${out}` : out;
}

export type PurchaseLineAmounts = {
  baseAmount: string;
  discount: string;
  taxableValue: string;
  taxAmount: string;
  lineTotal: string;
  /** "200 CT × ₹50.00/CT = ₹10,000.00" */
  formula: string;
};

export type PurchaseLineInput = {
  quantity: string | number;
  unit: UnitCode;
  rate: string | number;
  discount?: string | number | null;
  gstRatePercent?: string | number | null;
  taxType?: "EXCLUSIVE" | "INCLUSIVE";
};

const inr = (s: string) => {
  const [i, f] = s.split(".");
  // Indian grouping: last 3 digits, then pairs.
  const head = i.length > 3 ? `${i.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${i.slice(-3)}` : i;
  return `₹${head}.${f ?? "00"}`;
};

/** The line's amounts, or the reason it is not valid. */
export function purchaseLineAmounts(line: PurchaseLineInput): { ok: true; amounts: PurchaseLineAmounts } | { ok: false; error: string } {
  const qty = parseFixed(line.quantity, QTY_DP);
  if (!qty || qty.v <= BigInt(0)) return { ok: false, error: `Quantity must be more than zero (at most ${QTY_DP} decimals).` };
  const rate = parseFixed(line.rate, RATE_DP);
  if (!rate || rate.v <= BigInt(0)) return { ok: false, error: `Rate must be more than zero (at most ${RATE_DP} decimals).` };
  const discount = line.discount === null || line.discount === undefined || String(line.discount).trim() === "" ? { v: BigInt(0), dp: MONEY_DP } : parseFixed(line.discount, MONEY_DP);
  if (!discount) return { ok: false, error: "Discount must be a non-negative amount with at most 2 decimals." };
  const gst = line.gstRatePercent === null || line.gstRatePercent === undefined || String(line.gstRatePercent).trim() === "" ? { v: BigInt(0), dp: 2 } : parseFixed(line.gstRatePercent, 2);
  if (!gst || gst.v > BigInt(100) * pow10(2)) return { ok: false, error: "GST % must be between 0 and 100 (at most 2 decimals)." };
  if (qty.v > BigInt(10) ** BigInt(9 + QTY_DP) || rate.v > BigInt(10) ** BigInt(9 + RATE_DP)) return { ok: false, error: "Quantity or rate is too large." };

  const base = roundTo(mul(qty, rate), MONEY_DP);
  const disc = roundTo(discount, MONEY_DP);
  if (disc.v > base.v) return { ok: false, error: "Discount cannot be more than the base amount." };
  const net = sub(base, disc);
  let taxable: Fixed;
  let tax: Fixed;
  const hundred: Fixed = { v: BigInt(100), dp: 0 };
  if ((line.taxType ?? "EXCLUSIVE") === "INCLUSIVE") {
    taxable = mulDiv(net, hundred, add(hundred, gst), MONEY_DP);
    tax = sub(net, taxable);
  } else {
    taxable = net;
    tax = mulDiv(net, gst, hundred, MONEY_DP);
  }
  const total = add(taxable, tax);
  const f = (x: Fixed) => formatFixed(roundTo(x, MONEY_DP));
  const qtyText = formatFixed(qty).replace(/\.?0+$/, "") || "0";
  const rateText = formatFixed(roundTo(rate, Math.max(MONEY_DP, rate.v % pow10(RATE_DP - MONEY_DP) === BigInt(0) ? MONEY_DP : RATE_DP)));
  return {
    ok: true,
    amounts: {
      baseAmount: f(base),
      discount: f(disc),
      taxableValue: f(taxable),
      taxAmount: f(tax),
      lineTotal: f(total),
      formula: `${qtyText} ${line.unit} × ${inr(rateText)}/${line.unit} = ${inr(f(base))}`,
    },
  };
}

/** Sum of money strings, exact. */
export function sumMoney(values: string[]): string {
  return formatFixed(values.reduce<Fixed>((s, v) => add(s, parseFixed(v, MONEY_DP) ?? { v: BigInt(0), dp: MONEY_DP }), { v: BigInt(0), dp: MONEY_DP }));
}
