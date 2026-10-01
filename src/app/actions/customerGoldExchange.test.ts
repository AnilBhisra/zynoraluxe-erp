import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 8C server actions: every Old Gold Exchange / purchase-reversal action
 * is Owner-only at the action layer (and again in the library), refuses to
 * post without the preview's fingerprint, and returns Staff nothing.
 */
const m = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  requireUser: vi.fn(),
  plan: vi.fn(),
  exchange: vi.fn(),
  block: vi.fn(),
  reverse: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("@/lib/auth/dal", () => ({ requireOwner: m.requireOwner, requireUser: m.requireUser }));
vi.mock("@/lib/db/prisma", () => ({ prisma: { $transaction: m.transaction, customerGoldPurchase: { findUnique: vi.fn() } } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/accounting/company", () => ({ getCompanyFySettings: vi.fn(async () => ({ fyStartMonth: 4, fyStartDay: 1 })) }));
vi.mock("@/lib/storage/jewelleryMedia", () => ({ deleteJewelleryAsset: vi.fn() }));
vi.mock("@/lib/jewellery/oldGoldExchange", () => ({
  planOldGoldExchange: m.plan,
  oldGoldExchangeFingerprint: () => "fp",
  exchangeOldGold: m.exchange,
  customerGoldPurchaseReversalBlock: m.block,
  reverseCustomerGoldPurchase: m.reverse,
}));

import { CustomerGoldError } from "@/lib/jewellery/customerGoldLedger";
import { exchangeOldGoldAction, previewCustomerGoldPurchaseReversalAction, previewOldGoldExchangeAction, reverseCustomerGoldPurchaseAction } from "./customerGold";

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const EXCHANGE = {
  customerId: "c1",
  exchangeDate: "2026-10-01",
  purityId: "p22",
  inputBasis: "GROSS",
  weight: "10.255",
  deductionWeight: "0.25",
  rateBasis: "PER_FINE_GRAM",
  rate: "6543.21987",
  settlement: "CREDIT_TO_INVOICE",
  reason: "Old bangles",
  reference: "OG-1",
  idempotencyKey: "k1",
};
const staffRedirect = () => {
  throw new Error("NEXT_REDIRECT /unauthorized");
};

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.requireOwner.mockResolvedValue({ id: "owner", role: "OWNER" });
  m.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({}));
});

describe("Old Gold Exchange actions", () => {
  it("Staff are refused by every action before anything runs", async () => {
    m.requireOwner.mockImplementation(staffRedirect);
    await expect(previewOldGoldExchangeAction(undefined, fd(EXCHANGE))).rejects.toThrow(/unauthorized/);
    await expect(exchangeOldGoldAction(undefined, fd({ ...EXCHANGE, previewFingerprint: "fp", approved: "1" }))).rejects.toThrow(/unauthorized/);
    await expect(previewCustomerGoldPurchaseReversalAction(undefined, fd({ purchaseId: "p" }))).rejects.toThrow(/unauthorized/);
    await expect(reverseCustomerGoldPurchaseAction(undefined, fd({ purchaseId: "p", reason: "x".repeat(12), idempotencyKey: "r" }))).rejects.toThrow(/unauthorized/);
    expect([m.plan, m.exchange, m.block, m.reverse].every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it("posting without the preview's fingerprint is refused", async () => {
    const r = await exchangeOldGoldAction(undefined, fd(EXCHANGE));
    expect(r?.error).toMatch(/Preview first/);
    expect(m.exchange).not.toHaveBeenCalled();
  });

  it("passes the parsed form exactly (stated purity, deduction, 4-dp rate untouched, reference) and the approval", async () => {
    m.exchange.mockResolvedValue({ purchase: { purchaseCode: "ZL-CGP-1", id: "pur1" }, replayed: false });
    const r = await exchangeOldGoldAction(undefined, fd({ ...EXCHANGE, statedPurity: "22K hallmark", previewFingerprint: "fp", approved: "1" }));
    expect(r).toEqual({ success: true, code: "ZL-CGP-1", id: "pur1", replayed: false });
    expect(m.exchange).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        customerId: "c1",
        statedPurity: "22K hallmark",
        inputBasis: "GROSS",
        weight: "10.255",
        deductionWeight: "0.25",
        rate: "6543.21987",
        reference: "OG-1",
        approved: true,
        expectedFingerprint: "fp",
        idempotencyKey: "k1",
        actor: { id: "owner", role: "OWNER" },
      })
    );
  });

  it("a library refusal comes back as its own message; an unknown rate basis is refused", async () => {
    m.plan.mockRejectedValue(new CustomerGoldError("Enter the reference (bill, slip or register number) for this exchange."));
    expect((await previewOldGoldExchangeAction(undefined, fd(EXCHANGE))).error).toMatch(/Enter the reference/);
    expect((await previewOldGoldExchangeAction(undefined, fd({ ...EXCHANGE, rateBasis: "PER_KILO" }))).error).toMatch(/Choose how the rate is given/);
  });

  it("reversal check returns the block with the purchase id; reversal passes the reason and key", async () => {
    m.block.mockResolvedValue("Reverse that bill first.");
    expect(await previewCustomerGoldPurchaseReversalAction(undefined, fd({ purchaseId: "pur1" }))).toEqual({ purchaseId: "pur1", block: "Reverse that bill first." });
    m.reverse.mockResolvedValue({ purchase: { purchaseCode: "ZL-CGP-1" }, replayed: false });
    const r = await reverseCustomerGoldPurchaseAction(undefined, fd({ purchaseId: "pur1", reason: "Rate agreed wrongly", idempotencyKey: "rk" }));
    expect(r?.success).toBe(true);
    expect(m.reverse).toHaveBeenCalledWith({}, expect.objectContaining({ purchaseId: "pur1", reason: "Rate agreed wrongly", idempotencyKey: "rk" }));
  });
});
