/**
 * Runs once before the real-database (`*.db.test.ts`) project.
 *
 * 1. Refuses to run at all unless the connection is the DISPOSABLE scratch
 *    database (its own PostgreSQL server) — never the manual-testing database,
 *    because step 2 truncates business tables.
 * 2. Clears ALL business data (never masters). Diamond lots, jobs, packets and
 *    Jewellery Jobs reference vouchers and parties, and the correction suite
 *    clears those wholesale, so rows left behind by a crashed run would make a
 *    suite fail on a foreign-key error.
 */
import "dotenv/config";

import { Client } from "pg";

import { CLEAR_BUSINESS_DATA_SQL } from "./businessTables";
import { assertDisposableTestDb } from "./dbGuard";

export default async function setup() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — the DB suites need the disposable scratch database.");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ db: string; usr: string; port: number }>(
      "select current_database() as db, current_user as usr, inet_server_port() as port"
    );
    assertDisposableTestDb(rows[0]);
    await client.query(CLEAR_BUSINESS_DATA_SQL);
  } finally {
    await client.end();
  }
}
