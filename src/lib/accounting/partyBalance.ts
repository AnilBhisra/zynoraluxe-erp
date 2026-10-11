/**
 * How a party's balance is read and labelled — the one rule every screen uses
 * (Parties list, Ledger, Receivable & Payable report, Dashboard, Karigar
 * account, payment forms). No database access here, so client components can
 * use it too.
 *
 * The balance is always the party's posted journal lines on Accounts
 * Receivable (1100) and Accounts Payable (2000) together, as Debit − Credit:
 * positive means the party owes us, negative means we owe the party. A
 * cancelled voucher needs no filtering — its REVERSAL mirror nets it to zero.
 *
 * Which side is "normal" depends on who the party is. A Customer normally owes
 * us; a Supplier, Karigar, Manufacturer or Dalal/Broker is normally owed. A
 * balance on the other side is an advance, not a negative receivable/payable:
 * - a Supplier/Karigar we paid more than we were billed  -> ADVANCE_PAID
 * - a Customer who paid us more than we billed (or who sold us gold that is
 *   still credited to them)                                -> CUSTOMER_CREDIT
 *
 * Money is handled as whole paise (integers — exact far beyond any real
 * balance) so client-side arithmetic never goes through fractional floating
 * point.
 */
import type { PartyTypeValue } from "@/lib/parties/types";

export type PartyBalanceKind = "SETTLED" | "RECEIVABLE" | "PAYABLE" | "ADVANCE_PAID" | "CUSTOMER_CREDIT";

/** Parses a money string ("-1234.5", "20500.00") into paise, rounding half up at the third decimal. */
export function toPaise(value: string | number): number {
  const text = String(value).trim();
  const match = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (match[2] === "" && (match[3] ?? "") === "")) throw new Error(`Not a money amount: "${value}"`);
  const negative = match[1] === "-";
  const whole = Number(match[2] || "0");
  const frac = (match[3] ?? "").padEnd(3, "0");
  let paise = whole * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) paise += 1;
  if (!Number.isSafeInteger(paise)) throw new Error(`Amount out of range: "${value}"`);
  return negative && paise !== 0 ? -paise : paise;
}

/** Paise back to a plain two-decimal string ("-1234.50"). */
export function fromPaise(paise: number): string {
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const text = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return negative ? `-${text}` : text;
}

/** "₹1,23,456.78" (Indian grouping) for a non-negative two-decimal string. */
export function formatRupees(amount: string): string {
  const [whole, frac = "00"] = amount.replace(/^-/, "").split(".");
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `${amount.startsWith("-") ? "-" : ""}₹${grouped}.${frac.padEnd(2, "0").slice(0, 2)}`;
}

export type ClassifiedPartyBalance = {
  kind: PartyBalanceKind;
  /** Always non-negative, two decimals. */
  amount: string;
  /** Short badge text, e.g. "We owe ₹20,500.00" or "Advance paid ₹500.00". */
  label: string;
  /** One-word direction for tables and CSV: Settled / Receivable / Payable / Advance paid / Customer credit. */
  direction: string;
  /** One sentence for whoever is about to pay or receive. */
  explanation: string;
};

export function classifyPartyBalance(type: PartyTypeValue, balance: string | number): ClassifiedPartyBalance {
  const paise = toPaise(balance);
  const amount = fromPaise(Math.abs(paise));
  const money = formatRupees(amount);
  if (paise === 0) {
    return { kind: "SETTLED", amount, label: "Settled", direction: "Settled", explanation: "Nothing is owed either way." };
  }
  const isCustomer = type === "CUSTOMER";
  if (paise > 0) {
    return isCustomer
      ? { kind: "RECEIVABLE", amount, label: `Owes us ${money}`, direction: "Receivable", explanation: `The customer owes us ${money}.` }
      : {
          kind: "ADVANCE_PAID",
          amount,
          label: `Advance paid ${money}`,
          direction: "Advance paid",
          explanation: `We have paid ${money} more than we were billed. It is adjusted against their next bill (or they refund it).`,
        };
  }
  return isCustomer
    ? {
        kind: "CUSTOMER_CREDIT",
        amount,
        label: `Customer credit ${money}`,
        direction: "Customer credit",
        explanation: `We hold ${money} of the customer's money (an advance or a credit). It is adjusted against their next bill, or refunded.`,
      }
    : { kind: "PAYABLE", amount, label: `We owe ${money}`, direction: "Payable", explanation: `We owe them ${money}.` };
}

export type PaymentDirection = "PAYMENT_GIVEN" | "PAYMENT_RECEIVED";

export type PaymentEffect = {
  /** What the payment does to what is owed: settles it exactly, partly, or goes past it into an advance. */
  outcome: "EXACT" | "PARTIAL" | "OVERPAYMENT" | "ADVANCE";
  outcomeLabel: string;
  before: ClassifiedPartyBalance;
  after: ClassifiedPartyBalance;
};

/**
 * The effect of a payment on the party's balance — the same arithmetic the
 * posting performs: Payment Given debits the party (Dr Accounts Payable), so
 * the balance moves up by the amount; Payment Received credits the party (Cr
 * Accounts Receivable), so it moves down by the amount.
 */
export function paymentEffect(
  direction: PaymentDirection,
  type: PartyTypeValue,
  balance: string,
  amount: string
): PaymentEffect | null {
  let pay: number;
  try {
    pay = toPaise(amount);
  } catch {
    return null;
  }
  if (pay <= 0) return null;
  const beforePaise = toPaise(balance);
  const afterPaise = direction === "PAYMENT_GIVEN" ? beforePaise + pay : beforePaise - pay;
  // What this payment settles: for Payment Given, the amount we owe (a
  // negative balance); for Payment Received, the amount owed to us.
  const owed = direction === "PAYMENT_GIVEN" ? Math.max(-beforePaise, 0) : Math.max(beforePaise, 0);
  const outcome: PaymentEffect["outcome"] = owed === 0 ? "ADVANCE" : pay === owed ? "EXACT" : pay < owed ? "PARTIAL" : "OVERPAYMENT";
  const after = classifyPartyBalance(type, fromPaise(afterPaise));
  const outcomeLabel =
    outcome === "EXACT"
      ? "Exact settlement"
      : outcome === "PARTIAL"
        ? `Partial payment — ${after.label.toLowerCase()} remains`
        : outcome === "OVERPAYMENT"
          ? `Overpayment — the extra ${formatRupees(fromPaise(pay - owed))} becomes ${direction === "PAYMENT_GIVEN" && type !== "CUSTOMER" ? "an advance paid" : direction === "PAYMENT_RECEIVED" && type === "CUSTOMER" ? "customer credit" : "a balance the other way"}`
          : "Nothing is owed on this side — the whole amount is an advance";
  return { outcome, outcomeLabel, before: classifyPartyBalance(type, fromPaise(beforePaise)), after };
}
