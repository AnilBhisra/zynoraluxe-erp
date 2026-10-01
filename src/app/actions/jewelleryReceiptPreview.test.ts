import { beforeEach, describe, expect, it, vi } from "vitest";

import { Decimal } from "@/lib/accounting/money";

/**
 * Server-side privacy of the receipt Preview: the posting dry run (which
 * carries Company cost) runs ONLY for the Owner; Staff get their own charges
 * echoed and nothing else. Charges are read from the submitted form exactly as
 * Save reads them.
 */
const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireOwner: vi.fn(),
  dryRun: vi.fn(),
  plan: vi.fn(),
  custodyPlan: vi.fn(),
}));
vi.mock("@/lib/auth/dal", () => ({ requireUser: mocks.requireUser, requireOwner: mocks.requireOwner }));
vi.mock("@/lib/db/prisma", () => ({ prisma: { $transaction: vi.fn() } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/accounting/company", () => ({ getCompanyFySettings: vi.fn(async () => ({ fyStartMonth: 4, fyStartDay: 1 })) }));
vi.mock("@/lib/jewellery/receiptPostingPreview", async () => {
  const actual = await vi.importActual<typeof import("@/lib/jewellery/receiptPostingPreview")>("@/lib/jewellery/receiptPostingPreview");
  return { ...actual, dryRunReceiptPosting: mocks.dryRun };
});
vi.mock("@/lib/jewellery/customerGoldJobReceipt", () => ({
  planCustomerGoldJobReceipt: mocks.plan,
  customerGoldJobReceiptFingerprint: () => "fp",
  receiveWithCustomerGold: vi.fn(),
}));
vi.mock("@/lib/jewellery/receiptCustody", async () => {
  const actual = await vi.importActual<typeof import("@/lib/jewellery/receiptCustody")>("@/lib/jewellery/receiptCustody");
  return { ...actual, planReceiptCustody: mocks.custodyPlan, toReceiptCustodyPreview: () => ({ fingerprint: "fp-c" }), receiveWithCustodyAllocation: vi.fn() };
});

import { previewCustomerGoldReceiptAction, previewReceiptCustodyAction } from "./jewellery";

const D = (v: string) => new Decimal(v);
const W = (g: string, f: string) => ({ gross: D(g), fine: D(f) });
const PLAN = {
  jobCode: "ZL-JJOB-2026-000003", customerName: "YOGESHBHAI SAHYOG", karigarName: "AMULAY JAWE", sourceLabel: "GOLD 24K",
  pool: { finenessPercentSnapshot: D("100.000") },
  outputs: [{ netWeight: D("44.091"), purityDisplayName: "14K", finenessPercent: D("60.000"), fineWeight: D("26.455"), customerFine: D("26.455") }],
  outputFine: D("26.455"), customerFineForOutputs: D("26.455"), companyFineForOutputs: D("0"),
  returned: W("0", "0"), scrap: W("0", "0"), lossFine: D("0"), neededFine: D("26.455"),
  onJobBefore: W("0", "0"), fromKarigar: W("26.455", "26.455"), fromSafe: W("0", "0"), karigarAfter: W("0", "0"), safeAfter: W("3.545", "3.545"), onJobAfter: W("0", "0"),
  completesJob: true, mixed: false,
  company: { pendingBefore: D("0"), finishedFine: D("0"), returnedFine: D("0"), scrapFine: D("0"), processLossFine: D("0"), pendingAfter: D("0"), costMoved: D("0") },
};
const POSTING = { materials: "60807.78", charges: "41886.00", customerGoldCost: "0.00", customerGoldFine: "26.455", totalCompanyCost: "102693.78", lines: [], balanced: true };

function form(extra: Record<string, string> = {}) {
  const fd = new FormData();
  const fields: Record<string, string> = {
    jobId: "job-3",
    receiveDate: "2026-10-01",
    outputsJson: JSON.stringify([{ jewelleryType: "BRACELET", quantity: "1", netMetalWeight: "44.091", metalType: "GOLD", purityId: "p14", diamondIds: [], qcStatus: "PASSED" }]),
    diamondResolutionsJson: "[]",
    packetResolutionsJson: "[]",
    returnedMetalLinesJson: "[]",
    scrapMetalLinesJson: "[]",
    includedAlloyGrossWeight: "17.636",
    makingCharge: "41886",
    markJobComplete: "true",
    customerGoldSourcePurityId: "p24",
    customerGoldFineness: "100.000",
    custodySourcePurityId: "p24",
    ...extra,
  };
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  mocks.dryRun.mockReset().mockResolvedValue(POSTING);
  mocks.plan.mockReset().mockResolvedValue(PLAN);
  mocks.custodyPlan.mockReset().mockResolvedValue({});
});

describe("receipt Preview — charges echoed from the form; cost only for the Owner", () => {
  it("Owner: the server read Making ₹41,886 and returns the exact posting", async () => {
    mocks.requireUser.mockResolvedValue({ id: "owner-1", role: "OWNER" });
    const r = await previewCustomerGoldReceiptAction(undefined, form());
    expect(r.error).toBeUndefined();
    expect(r.preview?.charges).toEqual({ labour: "0.00", making: "41886.00", setting: "0.00", plating: "0.00", other: "0.00", total: "41886.00" });
    expect(r.preview?.posting).toEqual(POSTING);
    expect(mocks.dryRun).toHaveBeenCalledTimes(1);
  });

  it("Staff: the charge they typed is echoed, the cost dry run never runs, and no Rs figure of the Company leaves the server", async () => {
    mocks.requireUser.mockResolvedValue({ id: "staff-1", role: "STAFF" });
    const r = await previewCustomerGoldReceiptAction(undefined, form({ makingCharge: "500" }));
    expect(r.preview?.charges.total).toBe("500.00");
    expect(r.preview?.posting).toBeNull();
    expect(r.preview?.company.costMoved).toBeNull();
    expect(mocks.dryRun).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toMatch(/60807|102693|41886/);
  });

  it("Karigar Metal preview: same rule — Owner gets the posting, Staff never trigger it", async () => {
    mocks.requireUser.mockResolvedValue({ id: "owner-1", role: "OWNER" });
    const o = await previewReceiptCustodyAction(undefined, form({ labourCharge: "700", makingCharge: "0" }));
    expect([o.preview?.charges.labour, o.preview?.posting]).toEqual(["700.00", POSTING]);
    mocks.dryRun.mockClear();
    mocks.requireUser.mockResolvedValue({ id: "staff-1", role: "STAFF" });
    const s = await previewReceiptCustodyAction(undefined, form({ labourCharge: "700", makingCharge: "0" }));
    expect([s.preview?.charges.labour, s.preview?.posting]).toEqual(["700.00", null]);
    expect(mocks.dryRun).not.toHaveBeenCalled();
  });

  it("a negative or malformed charge is refused by the same validation Save uses", async () => {
    mocks.requireUser.mockResolvedValue({ id: "owner-1", role: "OWNER" });
    const r = await previewCustomerGoldReceiptAction(undefined, form({ makingCharge: "-5" }));
    expect(r.error).toBeTruthy();
    expect(mocks.dryRun).not.toHaveBeenCalled();
  });
});
