/**
 * Runs once before the real-database (`*.db.test.ts`) project.
 *
 * 1. Refuses to run at all unless the connection is the isolated test
 *    database as the isolated test user — so no DB suite can ever be pointed
 *    at anything else by accident.
 * 2. Clears leftover DIAMOND rows. Diamond lots, jobs and receipts reference
 *    vouchers, and the correction suite clears vouchers wholesale, so rows
 *    left behind by a manual browser session (or a crashed run) would make
 *    that suite fail on a foreign-key error. Vouchers themselves are left for
 *    the suites that own them.
 */
import "dotenv/config";

import { Client } from "pg";

export default async function setup() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — the DB suites need the isolated test database.");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ db: string; usr: string }>("select current_database() as db, current_user as usr");
    const { db, usr } = rows[0];
    if (db !== "zynoraluxe_phase7_test" || usr !== "zynoraluxe_phase7_user") {
      throw new Error(`Refusing to run DB suites against ${db} as ${usr}; the isolated test database is required.`);
    }
    await client.query(
      `delete from stock_movements where "roughPieceId" is not null or "polishedDiamondId" is not null or "diamondJobId" is not null`
    );
    for (const table of ["polished_diamonds", "diamond_job_pieces", "rough_pieces", "polished_receipts", "diamond_jobs", "rough_lots"]) {
      await client.query(`delete from "${table}"`);
    }
  } finally {
    await client.end();
  }
}
