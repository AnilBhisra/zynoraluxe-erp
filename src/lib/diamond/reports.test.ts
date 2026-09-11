import { describe, expect, it, vi } from "vitest";

// deriveRoughLotStatus itself never touches the database, but importing
// this module does (module-scope `import { prisma } from "@/lib/db/prisma"`,
// which eagerly constructs a client requiring DATABASE_URL) — mock it out,
// matching the pattern already used in src/lib/accounting/reports.test.ts.
vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));

import { deriveRoughLotStatus } from "./reports";

describe("deriveRoughLotStatus", () => {
  it("is Available when every piece is Available", () => {
    expect(deriveRoughLotStatus(["AVAILABLE", "AVAILABLE"])).toBe("AVAILABLE");
  });

  it("is Available for an empty piece list (defensive default)", () => {
    expect(deriveRoughLotStatus([])).toBe("AVAILABLE");
  });

  it("is Partly Issued when some but not all pieces are unavailable", () => {
    expect(deriveRoughLotStatus(["AVAILABLE", "WITH_KARIGAR"])).toBe("PARTLY_ISSUED");
  });

  it("is Fully Issued when no piece is Available but not all are Completed", () => {
    expect(deriveRoughLotStatus(["WITH_KARIGAR", "WITH_KARIGAR"])).toBe("FULLY_ISSUED");
    expect(deriveRoughLotStatus(["WITH_KARIGAR", "COMPLETED"])).toBe("FULLY_ISSUED");
  });

  it("is Completed when every non-cancelled piece is Completed", () => {
    expect(deriveRoughLotStatus(["COMPLETED", "COMPLETED"])).toBe("COMPLETED");
  });

  it("ignores Cancelled pieces when deriving the rollup among the rest", () => {
    expect(deriveRoughLotStatus(["COMPLETED", "CANCELLED"])).toBe("COMPLETED");
    expect(deriveRoughLotStatus(["AVAILABLE", "CANCELLED"])).toBe("AVAILABLE");
  });

  it("is Cancelled only when every piece is Cancelled", () => {
    expect(deriveRoughLotStatus(["CANCELLED", "CANCELLED"])).toBe("CANCELLED");
  });
});
