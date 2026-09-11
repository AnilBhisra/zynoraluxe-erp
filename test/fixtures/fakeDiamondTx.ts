import { createFakeAccountingTx } from "./fakeAccountingTx";

/**
 * Extends the Phase 2 fake accounting transaction client with the Phase 3
 * diamond-manufacturing tables, so src/lib/diamond/posting.ts's REAL code
 * can be exercised (rough purchase, issue, receive, cancel, recut,
 * allocation overrides) without a live database — mirroring the same
 * pattern as fakeAccountingTx.ts.
 */

type Row = Record<string, unknown>;

export function createFakeDiamondTx() {
  const base = createFakeAccountingTx();

  const diamondSequences = new Map<string, Row>(); // keyed by `${type}::${year}`
  const roughLots = new Map<string, Row>();
  const roughPieces = new Map<string, Row>();
  const diamondJobPieces = new Map<string, Row>();
  const diamondJobs = new Map<string, Row>();
  const polishedReceipts = new Map<string, Row>();
  const polishedDiamonds = new Map<string, Row>();
  const stockMovements = new Map<string, Row>();

  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-${++counter}`;

  function matchesWhere(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, value]) => {
      if (value === undefined) return true;
      if (value && typeof value === "object" && "in" in (value as Row)) {
        return ((value as Row).in as unknown[]).includes(row[key]);
      }
      return row[key] === value;
    });
  }

  const tx = {
    ...base.tx,
    diamondSequence: {
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { sequenceType_yearLabel: { sequenceType: string; yearLabel: string } };
        create: Row;
        update: { lastNumber: { increment: number } };
      }) => {
        const { sequenceType, yearLabel } = where.sequenceType_yearLabel;
        const key = `${sequenceType}::${yearLabel}`;
        const existing = diamondSequences.get(key);
        if (existing) {
          existing.lastNumber = (existing.lastNumber as number) + update.lastNumber.increment;
          return existing;
        }
        const row = { id: nextId("dseq"), sequenceType, yearLabel, ...create };
        diamondSequences.set(key, row);
        return row;
      },
    },
    roughLot: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("lot"), ...data };
        roughLots.set(row.id as string, row);
        return row;
      },
      findUnique: async ({ where, include }: { where: { id: string }; include?: { pieces?: boolean } }) => {
        const row = roughLots.get(where.id);
        if (!row) return null;
        if (include?.pieces) {
          return { ...row, pieces: [...roughPieces.values()].filter((p) => p.lotId === where.id) };
        }
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = roughLots.get(where.id);
        if (!row) throw new Error("rough lot not found");
        Object.assign(row, data);
        return row;
      },
    },
    roughPiece: {
      create: async ({ data }: { data: Row }) => {
        // Prisma schema defaults not applied by this fake — mirror the two
        // this code relies on but never sets explicitly (status, costLocked).
        const row = { id: nextId("rgh"), status: "AVAILABLE", costLocked: false, ...data };
        roughPieces.set(row.id as string, row);
        return row;
      },
      findMany: async ({ where }: { where?: Row } = {}) => {
        const rows = [...roughPieces.values()];
        if (!where) return rows;
        return rows.filter((r) => matchesWhere(r, where));
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = roughPieces.get(where.id);
        if (!row) throw new Error("rough piece not found");
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const rows = [...roughPieces.values()].filter((r) => matchesWhere(r, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },
    diamondJobPiece: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("djp"), ...data };
        diamondJobPieces.set(row.id as string, row);
        return row;
      },
      findMany: async ({ where }: { where?: Row } = {}) => {
        const rows = [...diamondJobPieces.values()];
        if (!where) return rows;
        return rows.filter((r) => matchesWhere(r, where));
      },
    },
    diamondJob: {
      create: async ({ data }: { data: Row }) => {
        // Prisma schema defaults not applied by this fake — mirror the ones
        // this code relies on but never sets explicitly at issue time.
        const row = {
          id: nextId("job"),
          status: "ISSUED",
          receivedPolishedCarat: "0",
          returnedRoughCarat: "0",
          totalLabourCharge: "0",
          ...data,
        };
        diamondJobs.set(row.id as string, row);
        return row;
      },
      findUnique: async ({ where, include }: { where: { id: string }; include?: { pieces?: boolean } }) => {
        const row = diamondJobs.get(where.id);
        if (!row) return null;
        if (include?.pieces) {
          return { ...row, pieces: [...diamondJobPieces.values()].filter((p) => p.jobId === where.id) };
        }
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = diamondJobs.get(where.id);
        if (!row) throw new Error("diamond job not found");
        Object.assign(row, data);
        return row;
      },
    },
    polishedReceipt: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("rec"), ...data };
        polishedReceipts.set(row.id as string, row);
        return row;
      },
      findUnique: async ({ where, include }: { where: { id: string }; include?: { outputs?: boolean } }) => {
        const row = polishedReceipts.get(where.id);
        if (!row) return null;
        if (include?.outputs) {
          return { ...row, outputs: [...polishedDiamonds.values()].filter((p) => p.receiptId === where.id) };
        }
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = polishedReceipts.get(where.id);
        if (!row) throw new Error("polished receipt not found");
        Object.assign(row, data);
        return row;
      },
    },
    polishedDiamond: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("pol"), status: "AVAILABLE", ...data };
        polishedDiamonds.set(row.id as string, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => polishedDiamonds.get(where.id) ?? null,
      findMany: async ({ where }: { where?: Row } = {}) => {
        const rows = [...polishedDiamonds.values()];
        if (!where) return rows;
        return rows.filter((r) => matchesWhere(r, where));
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = polishedDiamonds.get(where.id);
        if (!row) throw new Error("polished diamond not found");
        Object.assign(row, data);
        return row;
      },
    },
    stockMovement: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("mov"), ...data };
        stockMovements.set(row.id as string, row);
        return row;
      },
      findMany: async ({ where }: { where?: Row } = {}) => {
        const rows = [...stockMovements.values()];
        if (!where) return rows;
        return rows.filter((r) => matchesWhere(r, where));
      },
    },
  };

  return {
    tx,
    state: {
      ...base.state,
      diamondSequences,
      roughLots,
      roughPieces,
      diamondJobPieces,
      diamondJobs,
      polishedReceipts,
      polishedDiamonds,
      stockMovements,
    },
    paymentAccountIdByMethod: base.paymentAccountIdByMethod,
  };
}

export type FakeDiamondTx = ReturnType<typeof createFakeDiamondTx>;
