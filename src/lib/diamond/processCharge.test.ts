import { describe, expect, it } from "vitest";

import { computeProcessCharge } from "./processCharge";

describe("computeProcessCharge", () => {
  it("charges per carat exactly, rounding half-up to paise", () => {
    expect(computeProcessCharge({ basis: "PER_CARAT", rate: "1250.5", carat: "3.333", pieces: 10, isFinal: false })).toBe("4167.92");
    expect(computeProcessCharge({ basis: "PER_CARAT", rate: "0.0001", carat: "0.001", pieces: 1, isFinal: false })).toBe("0.00");
  });

  it("charges per piece", () => {
    expect(computeProcessCharge({ basis: "PER_PIECE", rate: "12.345", carat: "1.000", pieces: 7, isFinal: false })).toBe("86.42");
  });

  it("charges a fixed amount only on the receipt that closes the job", () => {
    expect(computeProcessCharge({ basis: "FIXED", rate: "5000", carat: "2.000", pieces: 4, isFinal: false })).toBe("0.00");
    expect(computeProcessCharge({ basis: "FIXED", rate: "5000.005", carat: "2.000", pieces: 4, isFinal: true })).toBe("5000.01");
  });

  it("charges nothing when nothing was returned or used", () => {
    expect(computeProcessCharge({ basis: "PER_CARAT", rate: "900", carat: "0.000", pieces: 0, isFinal: true })).toBe("0.00");
  });

  it("rejects a negative or malformed rate", () => {
    expect(() => computeProcessCharge({ basis: "PER_CARAT", rate: "-1", carat: "1", pieces: 1, isFinal: false })).toThrow();
  });
});
