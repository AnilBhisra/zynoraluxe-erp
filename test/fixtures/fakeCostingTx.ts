import { createFakeJewelleryTx } from "./fakeJewelleryTx";

/**
 * Extends the Phase 4 fake jewellery transaction client (which itself
 * extends Phase 3's diamond fixture, which extends Phase 2's accounting
 * fixture) with the Phase 5 Costing tables, so src/lib/costing/engine.ts's
 * REAL code can be exercised without a live database.
 */

type Row = Record<string, unknown>;

export function createFakeCostingTx() {
  const base = createFakeJewelleryTx();

  const gstRates = new Map<string, Row>();
  const costingSequences = new Map<string, Row>(); // keyed by financialYearLabel
  const costSheets = new Map<string, Row>();
  const costSheetMetalLines = new Map<string, Row>();
  const costSheetDiamondLines = new Map<string, Row>();
  const costSheetOtherMaterialLines = new Map<string, Row>();
  const costSheetChargeLines = new Map<string, Row>();
  const costSheetAuditEvents = new Map<string, Row>();

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

  function seedGstRate(input: { label: string; ratePercent: string; isActive?: boolean }) {
    const row = { id: nextId("gst"), label: input.label, ratePercent: input.ratePercent, isActive: input.isActive ?? true };
    gstRates.set(row.id, row);
    return row;
  }

  function hydrateCostSheet(row: Row) {
    return {
      ...row,
      metalLines: [...costSheetMetalLines.values()].filter((l) => l.costSheetId === row.id),
      diamondLines: [...costSheetDiamondLines.values()].filter((l) => l.costSheetId === row.id),
      otherMaterialLines: [...costSheetOtherMaterialLines.values()].filter((l) => l.costSheetId === row.id),
      chargeLines: [...costSheetChargeLines.values()].filter((l) => l.costSheetId === row.id),
    };
  }

  /** sourcing.ts needs deep joins the base Jewellery fixture's
   * finishedJewellery mock never had to support (job/receipt+voucher/
   * purity/diamonds+polishedDiamond) — compose them by hand from the
   * already-inherited state maps rather than duplicating them. */
  function findFinishedJewelleryWithJoins(id: string) {
    const output = base.state.finishedJewelleryRows.get(id);
    if (!output) return null;
    const job = base.state.jewelleryJobs.get(output.jobId as string);
    const receipt = base.state.jewelleryReceipts.get(output.receiptId as string);
    const purity = base.state.metalPurities.get(output.purityId as string);
    const postingVoucher = receipt?.postingVoucherId
      ? (base.state as unknown as { vouchers: Map<string, Row> }).vouchers.get(receipt.postingVoucherId as string)
      : null;
    const diamonds = [...base.state.jewelleryDiamondIssueLines.values()]
      .filter((d) => d.jobId === output.jobId && d.setInFinishedJewelleryId === id)
      .map((d) => ({ ...d, polishedDiamond: base.state.polishedDiamonds.get(d.polishedDiamondId as string) }));
    return { ...output, job, receipt: { ...receipt, postingVoucher }, purity, diamonds };
  }

  const tx = {
    ...base.tx,
    finishedJewellery: {
      ...base.tx.finishedJewellery,
      findUnique: async ({ where }: { where: { id: string } }) => findFinishedJewelleryWithJoins(where.id),
    },
    gstRate: {
      findUnique: async ({ where }: { where: { id: string } }) => gstRates.get(where.id) ?? null,
    },
    costingSequence: {
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { financialYearLabel: string };
        create: Row;
        update: { lastNumber: { increment: number } };
      }) => {
        const existing = costingSequences.get(where.financialYearLabel);
        if (existing) {
          existing.lastNumber = (existing.lastNumber as number) + update.lastNumber.increment;
          // Return a SNAPSHOT, never the live mutable row — matching what
          // a real Postgres `UPDATE ... RETURNING` guarantees via row
          // locking (a caller's returned value is always exactly what its
          // own statement wrote, never a later transaction's further
          // increment). Returning the shared reference here let a slower
          // continuation observe a LATER call's already-incremented
          // value once resolved, since a JS microtask boundary sits
          // between this line and the caller reading `sequence.lastNumber`.
          return { ...existing };
        }
        const row = { id: nextId("cseq"), financialYearLabel: where.financialYearLabel, ...create };
        costingSequences.set(where.financialYearLabel, row);
        return { ...row };
      },
    },
    costSheet: {
      create: async ({ data }: { data: Row }) => {
        const row = {
          id: nextId("cs"),
          revisionNumber: 1,
          previousVersionId: null,
          finalizedAt: null,
          finalizedByUserId: null,
          archivedAt: null,
          archivedByUserId: null,
          updatedByUserId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        costSheets.set(row.id as string, row);
        return row;
      },
      findUnique: async ({ where, include }: { where: { id: string }; include?: Row }) => {
        const row = costSheets.get(where.id);
        if (!row) return null;
        return include ? hydrateCostSheet(row) : row;
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const row = costSheets.get(where.id);
        if (!row) throw new Error("cost sheet not found");
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = costSheets.get(where.id);
        if (!row) throw new Error("cost sheet not found");
        Object.assign(row, data);
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const row = costSheets.get(where.id);
        if (!row) throw new Error("cost sheet not found");
        costSheets.delete(where.id);
        for (const [id, l] of costSheetMetalLines) if (l.costSheetId === where.id) costSheetMetalLines.delete(id);
        for (const [id, l] of costSheetDiamondLines) if (l.costSheetId === where.id) costSheetDiamondLines.delete(id);
        for (const [id, l] of costSheetOtherMaterialLines) if (l.costSheetId === where.id) costSheetOtherMaterialLines.delete(id);
        for (const [id, l] of costSheetChargeLines) if (l.costSheetId === where.id) costSheetChargeLines.delete(id);
        for (const [id, e] of costSheetAuditEvents) if (e.costSheetId === where.id) costSheetAuditEvents.delete(id);
        return row;
      },
      findMany: async ({ where }: { where?: Row } = {}) => {
        const rows = [...costSheets.values()];
        return where ? rows.filter((r) => matchesWhere(r, where)) : rows;
      },
    },
    costSheetMetalLine: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("csml"), ...data };
        costSheetMetalLines.set(row.id as string, row);
        return row;
      },
      deleteMany: async ({ where }: { where: Row }) => {
        let count = 0;
        for (const [id, row] of costSheetMetalLines) {
          if (matchesWhere(row, where)) {
            costSheetMetalLines.delete(id);
            count++;
          }
        }
        return { count };
      },
      findMany: async ({ where }: { where?: Row } = {}) => {
        const rows = [...costSheetMetalLines.values()];
        return where ? rows.filter((r) => matchesWhere(r, where)) : rows;
      },
      count: async ({ where }: { where?: Row } = {}) => {
        const rows = [...costSheetMetalLines.values()];
        return (where ? rows.filter((r) => matchesWhere(r, where)) : rows).length;
      },
    },
    costSheetDiamondLine: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("csdl"), ...data };
        costSheetDiamondLines.set(row.id as string, row);
        return row;
      },
      deleteMany: async ({ where }: { where: Row }) => {
        let count = 0;
        for (const [id, row] of costSheetDiamondLines) {
          if (matchesWhere(row, where)) {
            costSheetDiamondLines.delete(id);
            count++;
          }
        }
        return { count };
      },
      findMany: async ({ where }: { where?: Row } = {}) => {
        const rows = [...costSheetDiamondLines.values()];
        return where ? rows.filter((r) => matchesWhere(r, where)) : rows;
      },
      count: async ({ where }: { where?: Row } = {}) => {
        const rows = [...costSheetDiamondLines.values()];
        return (where ? rows.filter((r) => matchesWhere(r, where)) : rows).length;
      },
    },
    costSheetOtherMaterialLine: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("csoml"), ...data };
        costSheetOtherMaterialLines.set(row.id as string, row);
        return row;
      },
      deleteMany: async ({ where }: { where: Row }) => {
        let count = 0;
        for (const [id, row] of costSheetOtherMaterialLines) {
          if (matchesWhere(row, where)) {
            costSheetOtherMaterialLines.delete(id);
            count++;
          }
        }
        return { count };
      },
      findMany: async ({ where }: { where?: Row } = {}) => {
        const rows = [...costSheetOtherMaterialLines.values()];
        return where ? rows.filter((r) => matchesWhere(r, where)) : rows;
      },
      count: async ({ where }: { where?: Row } = {}) => {
        const rows = [...costSheetOtherMaterialLines.values()];
        return (where ? rows.filter((r) => matchesWhere(r, where)) : rows).length;
      },
    },
    costSheetChargeLine: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("cscl"), ...data };
        costSheetChargeLines.set(row.id as string, row);
        return row;
      },
      deleteMany: async ({ where }: { where: Row }) => {
        let count = 0;
        for (const [id, row] of costSheetChargeLines) {
          if (matchesWhere(row, where)) {
            costSheetChargeLines.delete(id);
            count++;
          }
        }
        return { count };
      },
      findMany: async ({ where }: { where?: Row } = {}) => {
        const rows = [...costSheetChargeLines.values()];
        return where ? rows.filter((r) => matchesWhere(r, where)) : rows;
      },
      count: async ({ where }: { where?: Row } = {}) => {
        const rows = [...costSheetChargeLines.values()];
        return (where ? rows.filter((r) => matchesWhere(r, where)) : rows).length;
      },
    },
    costSheetAuditEvent: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("csae"), createdAt: new Date(), ...data };
        costSheetAuditEvents.set(row.id as string, row);
        return row;
      },
      findMany: async ({ where }: { where?: Row } = {}) => {
        const rows = [...costSheetAuditEvents.values()];
        return where ? rows.filter((r) => matchesWhere(r, where)) : rows;
      },
    },
  };

  return {
    tx,
    state: {
      ...base.state,
      gstRates,
      costingSequences,
      costSheets,
      costSheetMetalLines,
      costSheetDiamondLines,
      costSheetOtherMaterialLines,
      costSheetChargeLines,
      costSheetAuditEvents,
    },
    paymentAccountIdByMethod: base.paymentAccountIdByMethod,
    seedMetalPurity: base.seedMetalPurity,
    seedPolishedDiamond: base.seedPolishedDiamond,
    seedGstRate,
  };
}

export type FakeCostingTx = ReturnType<typeof createFakeCostingTx>;
