import { describe, expect, it } from "vitest";

import { loginSchema } from "./auth";

describe("loginSchema", () => {
  it("accepts a valid email and non-empty password", () => {
    const result = loginSchema.safeParse({
      email: "owner@example.com",
      password: "correct-horse",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid email", () => {
    const result = loginSchema.safeParse({
      email: "not-an-email",
      password: "correct-horse",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty password", () => {
    const result = loginSchema.safeParse({
      email: "owner@example.com",
      password: "",
    });
    expect(result.success).toBe(false);
  });

  it("trims surrounding whitespace from the email", () => {
    const result = loginSchema.safeParse({
      email: "  owner@example.com  ",
      password: "correct-horse",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe("owner@example.com");
    }
  });
});
