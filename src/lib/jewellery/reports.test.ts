import { describe, expect, it, vi } from "vitest";

// pendingFineWeightOf itself never touches the database, but importing this
// module does (module-scope `import { prisma } from "@/lib/db/prisma"`,
// which eagerly constructs a client requiring DATABASE_URL) — mock it out,
// matching the pattern already used in src/lib/diamond/reports.test.ts.
vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));

import { pendingFineWeightOf, setStoneTotals } from "./reports";

describe("pendingFineWeightOf", () => {
  it("is issued plus karigar-added, minus received/returned/scrap", () => {
    const pending = pendingFineWeightOf({
      issuedMetalFineWeight: "10.000",
      karigarAddedFineWeight: "1.000",
      receivedFineWeight: "4.000",
      returnedMetalFineWeight: "2.000",
      scrapFineWeight: "1.000",
    });
    expect(pending.toFixed(3)).toBe("4.000");
  });

  it("is zero for a freshly issued job with nothing yet resolved", () => {
    const pending = pendingFineWeightOf({
      issuedMetalFineWeight: "0.000",
      karigarAddedFineWeight: "0.000",
      receivedFineWeight: "0.000",
      returnedMetalFineWeight: "0.000",
      scrapFineWeight: "0.000",
    });
    expect(pending.toFixed(3)).toBe("0.000");
  });

  it("is exactly zero once a job fully resolves (finished + returned + scrap = issued + karigar-added)", () => {
    const pending = pendingFineWeightOf({
      issuedMetalFineWeight: "9.160",
      karigarAddedFineWeight: "0.000",
      receivedFineWeight: "8.244",
      returnedMetalFineWeight: "0.500",
      scrapFineWeight: "0.416",
    });
    expect(pending.toFixed(3)).toBe("0.000");
  });

  it("accepts Decimal-like inputs consistently regardless of string precision", () => {
    const pending = pendingFineWeightOf({
      issuedMetalFineWeight: "5",
      karigarAddedFineWeight: "0",
      receivedFineWeight: "2.5",
      returnedMetalFineWeight: "0",
      scrapFineWeight: "0",
    });
    expect(pending.toFixed(3)).toBe("2.500");
  });
});

describe("setStoneTotals (Phase 7)", () => {
  it("counts packet stones set into a piece alongside individually tracked diamonds", () => {
    const totals = setStoneTotals(
      [{ caratAtIssue: "0.500" }],
      [
        { pieces: 20, carat: "2.000" },
        { pieces: 30, carat: "3.000" },
      ]
    );
    expect(totals.count).toBe(51);
    expect(totals.carat.toFixed(3)).toBe("5.500");
  });

  it("is zero for a plain metal piece", () => {
    const totals = setStoneTotals([], []);
    expect(totals.count).toBe(0);
    expect(totals.carat.toFixed(3)).toBe("0.000");
  });
});
