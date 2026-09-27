import { describe, expect, it } from "vitest";

import { assertDisposableTestDb, DISPOSABLE_TEST_DB } from "./dbGuard";

describe("wiping DB suites only run on the disposable scratch database", () => {
  it("accepts the scratch database", () => {
    expect(() => assertDisposableTestDb({ db: DISPOSABLE_TEST_DB.db, usr: DISPOSABLE_TEST_DB.user, port: 54329 })).not.toThrow();
  });
  it("refuses the manual-testing database", () => {
    expect(() => assertDisposableTestDb({ db: "zynoraluxe_phase7_test", usr: "zynoraluxe_phase7_user", port: 5432 })).toThrow(/Refusing to run a wiping DB suite/);
  });
  it("refuses the right names on the wrong server (port)", () => {
    expect(() => assertDisposableTestDb({ db: DISPOSABLE_TEST_DB.db, usr: DISPOSABLE_TEST_DB.user, port: 5432 })).toThrow(/Refusing/);
  });
  it("refuses production-like and unknown databases and users", () => {
    expect(() => assertDisposableTestDb({ db: "postgres", usr: "postgres", port: 5432 })).toThrow(/Refusing/);
    expect(() => assertDisposableTestDb({ db: DISPOSABLE_TEST_DB.db, usr: "someone_else", port: 54329 })).toThrow(/Refusing/);
  });
});
