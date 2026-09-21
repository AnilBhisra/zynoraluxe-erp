import { describe, expect, it } from "vitest";

import { replayMetalValues, ReplayError, type ReplayInput } from "./metalReplay";

/**
 * The fixture is the REAL production 24K gold ledger as at 2026-09-21, and the
 * expected values are the ones the Owner approved in
 * PHASE_8_REVALUATION_PREVIEW.md. If this test ever changes, the approved
 * preview changed with it.
 */
const t = (minutes: number) => new Date(Date.UTC(2026, 8, 17, 22, minutes, 0));

function productionLedger(): ReplayInput {
  return {
    targetMovementId: "m-opening",
    targetNewCostValue: "351664.00",
    movements: [
      {
        id: "m-opening",
        type: "OPENING_IN",
        createdAt: t(50),
        grossWeight: "22.001",
        fineWeight: "21.979",
        costValue: "160000.00",
        sourceDocument: "Opening stock",
        jewelleryJobId: null,
      },
      {
        id: "m-issue-68",
        type: "ISSUE_OUT",
        createdAt: t(53),
        grossWeight: "10.000",
        fineWeight: "9.990",
        costValue: "72723.97",
        sourceDocument: "ZL-JJOB-2026-000068",
        jewelleryJobId: "job-68",
      },
      {
        id: "m-consumed-68",
        type: "CONSUMED_OUT",
        createdAt: t(87),
        grossWeight: "0.000",
        fineWeight: "4.162",
        costValue: "30298.01",
        sourceDocument: "ZL-JREC-2026-000052",
        jewelleryJobId: "job-68",
      },
      {
        id: "m-purchase",
        type: "PURCHASE_IN",
        createdAt: t(2900),
        grossWeight: "2.000",
        fineWeight: "2.000",
        costValue: "31050.00",
        sourceDocument: "ZL-MP-2026-000057",
        jewelleryJobId: null,
      },
      {
        id: "m-issue-69",
        type: "ISSUE_OUT",
        createdAt: t(2902),
        grossWeight: "2.000",
        fineWeight: "2.000",
        costValue: "16902.51",
        sourceDocument: "ZL-JJOB-2026-000069",
        jewelleryJobId: "job-69",
      },
      {
        id: "m-return-69",
        type: "RETURN_IN",
        createdAt: t(2910),
        grossWeight: "0.146",
        fineWeight: "0.146",
        costValue: "1233.88",
        sourceDocument: "ZL-JREC-2026-000053",
        jewelleryJobId: "job-69",
      },
      {
        id: "m-consumed-69",
        type: "CONSUMED_OUT",
        createdAt: t(2911),
        grossWeight: "0.000",
        fineWeight: "1.854",
        costValue: "15668.63",
        sourceDocument: "ZL-JREC-2026-000053",
        jewelleryJobId: "job-69",
      },
    ],
    receipts: [
      {
        id: "rec-52",
        code: "ZL-JREC-2026-000052",
        jobId: "job-68",
        isFinalMetal: false,
        outputs: [{ id: "fj-86", label: "ZL-FJ-2026-000086", fineMetalWeight: "4.162", metalCost: "30298.01" }],
      },
      {
        id: "rec-53",
        code: "ZL-JREC-2026-000053",
        jobId: "job-69",
        isFinalMetal: true,
        outputs: [{ id: "fj-87", label: "ZL-FJ-2026-000087", fineMetalWeight: "1.854", metalCost: "15668.63" }],
      },
    ],
  };
}

describe("replayMetalValues — approved production revaluation", () => {
  it("restates the usable pool to 1,93,361.21 (+90,703.81)", () => {
    const result = replayMetalValues(productionLedger());
    expect(result.usablePool.grossWeight.toFixed(3)).toBe("12.147");
    expect(result.usablePool.oldValue.toFixed(2)).toBe("102657.40");
    expect(result.usablePool.newValue.toFixed(2)).toBe("193361.21");
    expect(result.usablePool.delta.toFixed(2)).toBe("90703.81");
  });

  it("restates job 68's pending WIP to 93,248.01 (+50,822.05) without changing its weight", () => {
    const result = replayMetalValues(productionLedger());
    const wip = result.jobWip.get("job-68");
    expect(wip?.fineWeight.toFixed(3)).toBe("5.828");
    expect(wip?.oldValue.toFixed(2)).toBe("42425.96");
    expect(wip?.newValue.toFixed(2)).toBe("93248.01");
    expect(wip?.delta.toFixed(2)).toBe("50822.05");
  });

  it("restates both finished pieces by the approved amounts", () => {
    const result = replayMetalValues(productionLedger());
    const fj86 = result.finishedPieces.get("fj-86");
    const fj87 = result.finishedPieces.get("fj-87");
    expect(fj86?.newValue.toFixed(2)).toBe("66592.00");
    expect(fj86?.delta.toFixed(2)).toBe("36293.99");
    expect(fj87?.newValue.toFixed(2)).toBe("29512.78");
    expect(fj87?.delta.toFixed(2)).toBe("13844.15");
  });

  it("closes job 69 completely — a fully received job keeps no WIP value", () => {
    const result = replayMetalValues(productionLedger());
    expect(result.jobWip.get("job-69")).toBeUndefined();
  });

  it("allocates the whole 1,91,664.00 shortfall and nothing more", () => {
    const result = replayMetalValues(productionLedger());
    const total = result.usablePool.delta
      .plus(result.jobWip.get("job-68")!.delta)
      .plus(result.finishedPieces.get("fj-86")!.delta)
      .plus(result.finishedPieces.get("fj-87")!.delta);
    expect(total.toFixed(2)).toBe("191664.00");
  });

  it("keeps weighted average, not the newest purchase rate", () => {
    const result = replayMetalValues(productionLedger());
    // Job 69 drew from a pool of corrected opening gold (16,000/fine g) blended
    // with the 15,525/fine g purchase, so its issue is neither rate.
    const issue69 = result.movements.get("m-issue-69");
    expect(issue69?.newValue.toFixed(2)).toBe("31836.87");
    expect(issue69?.newValue.toFixed(2)).not.toBe("31050.00");
  });

  it("restates the returned metal at the job's own corrected rate", () => {
    const result = replayMetalValues(productionLedger());
    expect(result.movements.get("m-return-69")?.newValue.toFixed(2)).toBe("2324.09");
  });

  it("restates job 68's issue to 1,59,840.01", () => {
    const result = replayMetalValues(productionLedger());
    expect(result.movements.get("m-issue-68")?.newValue.toFixed(2)).toBe("159840.01");
  });

  it("changes nothing when the corrected value equals the original", () => {
    const result = replayMetalValues({ ...productionLedger(), targetNewCostValue: "160000.00" });
    expect(result.usablePool.delta.toFixed(2)).toBe("0.00");
    expect(result.jobWip.get("job-68")!.delta.toFixed(2)).toBe("0.00");
    expect(result.finishedPieces.get("fj-86")!.delta.toFixed(2)).toBe("0.00");
    expect(result.finishedPieces.get("fj-87")!.delta.toFixed(2)).toBe("0.00");
  });

  it("refuses a ledger it cannot reproduce rather than guessing", () => {
    const input = productionLedger();
    input.movements.push({
      id: "m-cancel",
      type: "ISSUE_CANCEL_IN",
      createdAt: t(3000),
      grossWeight: "1.000",
      fineWeight: "0.999",
      costValue: "1000.00",
      sourceDocument: "ZL-JJOB-2026-000070",
      jewelleryJobId: "job-70",
    });
    expect(() => replayMetalValues(input)).toThrow(ReplayError);
  });

  it("refuses when a receipt's finished pieces cannot be loaded", () => {
    const input = productionLedger();
    input.receipts = input.receipts.filter((r) => r.code !== "ZL-JREC-2026-000053");
    expect(() => replayMetalValues(input)).toThrow(/ZL-JREC-2026-000053/);
  });

  it("rejects a target movement that is not in this ledger", () => {
    expect(() => replayMetalValues({ ...productionLedger(), targetMovementId: "nope" })).toThrow(ReplayError);
  });
});

describe("replayMetalValues — scrap and multi-output shapes", () => {
  it("sends scrap to the scrap pool, never back into issuable stock", () => {
    const result = replayMetalValues({
      targetMovementId: "open",
      targetNewCostValue: "20000.00",
      movements: [
        {
          id: "open",
          type: "OPENING_IN",
          createdAt: t(1),
          grossWeight: "10.000",
          fineWeight: "10.000",
          costValue: "10000.00",
          sourceDocument: "Opening stock",
          jewelleryJobId: null,
        },
        {
          id: "iss",
          type: "ISSUE_OUT",
          createdAt: t(2),
          grossWeight: "4.000",
          fineWeight: "4.000",
          costValue: "4000.00",
          sourceDocument: "JOB-A",
          jewelleryJobId: "job-a",
        },
        {
          id: "scr",
          type: "SCRAP_RETURN_IN",
          createdAt: t(3),
          grossWeight: "1.000",
          fineWeight: "1.000",
          costValue: "1000.00",
          sourceDocument: "REC-A",
          jewelleryJobId: "job-a",
        },
        {
          id: "con",
          type: "CONSUMED_OUT",
          createdAt: t(4),
          grossWeight: "0.000",
          fineWeight: "3.000",
          costValue: "3000.00",
          sourceDocument: "REC-A",
          jewelleryJobId: "job-a",
        },
      ],
      receipts: [
        {
          id: "r",
          code: "REC-A",
          jobId: "job-a",
          isFinalMetal: true,
          outputs: [{ id: "p1", label: "P1", fineMetalWeight: "3.000", metalCost: "3000.00" }],
        },
      ],
    });
    // Opening doubled: 6 g left in stock is worth 12,000 and the scrap 2,000.
    expect(result.usablePool.newValue.toFixed(2)).toBe("12000.00");
    expect(result.usablePool.grossWeight.toFixed(3)).toBe("6.000");
    expect(result.scrapPool.newValue.toFixed(2)).toBe("2000.00");
    expect(result.finishedPieces.get("p1")?.newValue.toFixed(2)).toBe("6000.00");
  });

  it("splits a receipt's finished portion across several outputs by fine weight", () => {
    const result = replayMetalValues({
      targetMovementId: "open",
      targetNewCostValue: "30000.00",
      movements: [
        {
          id: "open",
          type: "OPENING_IN",
          createdAt: t(1),
          grossWeight: "10.000",
          fineWeight: "10.000",
          costValue: "10000.00",
          sourceDocument: "Opening stock",
          jewelleryJobId: null,
        },
        {
          id: "iss",
          type: "ISSUE_OUT",
          createdAt: t(2),
          grossWeight: "9.000",
          fineWeight: "9.000",
          costValue: "9000.00",
          sourceDocument: "JOB-B",
          jewelleryJobId: "job-b",
        },
        {
          id: "c1",
          type: "CONSUMED_OUT",
          createdAt: t(3),
          grossWeight: "0.000",
          fineWeight: "6.000",
          costValue: "6000.00",
          sourceDocument: "REC-B",
          jewelleryJobId: "job-b",
        },
        {
          id: "c2",
          type: "CONSUMED_OUT",
          createdAt: t(4),
          grossWeight: "0.000",
          fineWeight: "3.000",
          costValue: "3000.00",
          sourceDocument: "REC-B",
          jewelleryJobId: "job-b",
        },
      ],
      receipts: [
        {
          id: "r",
          code: "REC-B",
          jobId: "job-b",
          isFinalMetal: true,
          outputs: [
            { id: "p1", label: "P1", fineMetalWeight: "6.000", metalCost: "6000.00" },
            { id: "p2", label: "P2", fineMetalWeight: "3.000", metalCost: "3000.00" },
          ],
        },
      ],
    });
    expect(result.finishedPieces.get("p1")?.newValue.toFixed(2)).toBe("18000.00");
    expect(result.finishedPieces.get("p2")?.newValue.toFixed(2)).toBe("9000.00");
  });
});
