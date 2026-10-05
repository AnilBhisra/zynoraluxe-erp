import { describe, expect, it } from "vitest";

import { receiveProcessedRoughSchema } from "./diamond";

const base = { jobId: "job-1", receiveDate: "2026-10-05", markJobComplete: "false" };

describe("receiveProcessedRoughSchema", () => {
  it("a batch keeps the carat exactly as typed and a whole piece count", () => {
    const r = receiveProcessedRoughSchema.parse({ ...base, mode: "BATCH", batch: { pieceCount: "26", carat: "43.500", colorEstimate: "G-H", clarityNote: "" } });
    expect(r.mode).toBe("BATCH");
    expect(r.batch).toMatchObject({ pieceCount: 26, carat: "43.500", colorEstimate: "G-H" });
    expect(r.pieces).toEqual([]);
  });

  it("refuses a missing, zero or fractional piece count and a bad carat", () => {
    const err = (batch: object) => receiveProcessedRoughSchema.safeParse({ ...base, mode: "BATCH", batch }).error?.issues[0]?.message;
    expect(err({ carat: "43.500" })).toMatch(/number of returned pieces/);
    expect(err({ pieceCount: "0", carat: "43.500" })).toMatch(/at least 1/);
    expect(err({ pieceCount: "2.5", carat: "43.500" })).toMatch(/whole number/);
    expect(err({ pieceCount: "26", carat: "43.5001" })).toMatch(/at most 3 decimals/);
    expect(err({ pieceCount: "26", carat: "0.000" })).toMatch(/greater than zero/);
    expect(err({ pieceCount: "26", carat: "-1" })).toMatch(/at most 3 decimals/);
  });

  it("a batch with piece rows, or no batch at all, is refused", () => {
    expect(receiveProcessedRoughSchema.safeParse({ ...base, mode: "BATCH" }).success).toBe(false);
    expect(receiveProcessedRoughSchema.safeParse({ ...base, mode: "BATCH", batch: { pieceCount: "26", carat: "43.5" }, pieces: [{ carat: 1 }] }).success).toBe(false);
  });

  it("a form without a mode is the original individual-rows form", () => {
    const r = receiveProcessedRoughSchema.parse({ ...base, pieces: [{ carat: "10.000" }, { carat: "15.000" }] });
    expect(r.mode).toBe("INDIVIDUAL");
    expect(r.pieces).toHaveLength(2);
    expect(receiveProcessedRoughSchema.safeParse({ ...base, pieces: [] }).error?.issues[0]?.message).toMatch(/at least one processed rough piece/);
  });
});
