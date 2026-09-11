import { describe, expect, it } from "vitest";

import { companySettingsSchema, createStaffSchema } from "./settings";

const validCompany = {
  companyName: "Zynoraluxe Diamonds",
  address: "",
  phone: "",
  email: "",
  gstNumber: "",
  defaultCurrency: "INR",
  financialYearStartMonth: 4,
  financialYearStartDay: 1,
};

describe("companySettingsSchema", () => {
  it("accepts a minimal valid company (only name + currency + FY start)", () => {
    const result = companySettingsSchema.safeParse(validCompany);
    expect(result.success).toBe(true);
  });

  it("rejects a company name that is too short", () => {
    const result = companySettingsSchema.safeParse({ ...validCompany, companyName: "A" });
    expect(result.success).toBe(false);
  });

  it("rejects a currency code that is not 3 letters", () => {
    const result = companySettingsSchema.safeParse({ ...validCompany, defaultCurrency: "Rupees" });
    expect(result.success).toBe(false);
  });

  it("uppercases a lowercase currency code", () => {
    const result = companySettingsSchema.safeParse({ ...validCompany, defaultCurrency: "inr" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaultCurrency).toBe("INR");
    }
  });

  it("rejects a financial year start month outside 1-12", () => {
    const result = companySettingsSchema.safeParse({
      ...validCompany,
      financialYearStartMonth: 13,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a financial year start day outside 1-31", () => {
    const result = companySettingsSchema.safeParse({
      ...validCompany,
      financialYearStartDay: 32,
    });
    expect(result.success).toBe(false);
  });

  it("accepts a well-formed GSTIN", () => {
    const result = companySettingsSchema.safeParse({
      ...validCompany,
      gstNumber: "22AAAAA0000A1Z5",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a malformed GSTIN", () => {
    const result = companySettingsSchema.safeParse({
      ...validCompany,
      gstNumber: "not-a-gstin",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid email when one is provided", () => {
    const result = companySettingsSchema.safeParse({
      ...validCompany,
      email: "not-an-email",
    });
    expect(result.success).toBe(false);
  });
});

describe("createStaffSchema", () => {
  it("accepts a valid staff account", () => {
    const result = createStaffSchema.safeParse({
      name: "Asha Patel",
      email: "asha@example.com",
      password: "atleast8chars",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a password shorter than 8 characters", () => {
    const result = createStaffSchema.safeParse({
      name: "Asha Patel",
      email: "asha@example.com",
      password: "short1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid email", () => {
    const result = createStaffSchema.safeParse({
      name: "Asha Patel",
      email: "not-an-email",
      password: "atleast8chars",
    });
    expect(result.success).toBe(false);
  });
});
