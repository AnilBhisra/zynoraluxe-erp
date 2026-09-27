/**
 * The ONLY database the wiping real-database suites may run against: the
 * disposable scratch cluster (its own PostgreSQL server on port 54329).
 * The manual-testing database (localhost:5432, zynoraluxe_phase7_test) holds
 * hand-entered records and is deliberately NOT allowed here — these suites
 * truncate business tables.
 */
export const DISPOSABLE_TEST_DB = { db: "zynoraluxe_charge_scratch", user: "zynoraluxe_scratch_user", port: 54329 } as const;

export function assertDisposableTestDb(actual: { db: string; usr: string; port?: number | string | null }): void {
  const port = actual.port == null ? DISPOSABLE_TEST_DB.port : Number(actual.port);
  if (actual.db !== DISPOSABLE_TEST_DB.db || actual.usr !== DISPOSABLE_TEST_DB.user || port !== DISPOSABLE_TEST_DB.port) {
    throw new Error(
      `Refusing to run a wiping DB suite against ${actual.db} as ${actual.usr} on port ${port}; only the disposable scratch database (${DISPOSABLE_TEST_DB.db} on ${DISPOSABLE_TEST_DB.port}) is allowed.`
    );
  }
}
