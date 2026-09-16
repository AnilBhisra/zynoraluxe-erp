import { createFakePolishedTx } from "./fakePolishedTx";

/**
 * Extends the Phase 3 fake diamond transaction client (which itself
 * extends the Phase 2 fake accounting client) with the Phase 4
 * Metal/Jewellery tables, so src/lib/jewellery/posting.ts's REAL code can
 * be exercised (metal purchase, opening stock, adjustment, job creation,
 * material issue, receive, cancel, allocation overrides) without a live
 * database. Deliberately builds on the diamond fixture rather than
 * duplicating polishedDiamond/stockMovement support, since Jewellery
 * genuinely reuses those real Phase 3 tables — mirrors the same layering
 * fakeDiamondTx.ts uses over fakeAccountingTx.ts. Phase 7: layered over
 * fakePolishedTx instead, because a Jewellery job can now also consume bulk
 * polished PACKETS — the same real packet tables the Polished Purchase
 * engine writes.
 */

type Row = Record<string, unknown>;

export function createFakeJewelleryTx() {
  const base = createFakePolishedTx();

  const jewellerySequences = new Map<string, Row>(); // keyed by `${type}::${year}`
  const metalPurities = new Map<string, Row>();
  const metalPurchases = new Map<string, Row>();
  const metalStockMovements = new Map<string, Row>();
  const jewelleryJobs = new Map<string, Row>();
  const jewelleryMetalIssueLines = new Map<string, Row>();
  const jewelleryDiamondIssueLines = new Map<string, Row>();
  const jewelleryOtherMaterialLines = new Map<string, Row>();
  const jewelleryReceipts = new Map<string, Row>();
  const finishedJewelleryRows = new Map<string, Row>();
  const finishedJewelleryStockMovements = new Map<string, Row>();
  const jewelleryPacketIssueLines = new Map<string, Row>();
  const jewelleryPacketResolutions = new Map<string, Row>();

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

  /** Applies a Prisma-style update payload, honouring { increment: n } on numeric/decimal columns. */
  function applyData(row: Row, data: Row) {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "increment" in (value as Row)) {
        const inc = (value as Row).increment;
        const current = row[key];
        row[key] =
          typeof current === "number" && typeof inc === "number"
            ? current + inc
            : (Number(current ?? 0) + Number(inc)).toFixed(String(inc).includes(".") ? String(inc).split(".")[1].length : 0);
      } else {
        row[key] = value;
      }
    }
    return row;
  }

  /** Test helper — seed an ACTIVE PolishedPacket with its PURCHASE_IN movement. */
  function seedPolishedPacket(input: {
    packetCode: string;
    pieces: number;
    carat: string;
    costValue: string;
    shape?: string;
    sizeLabel?: string;
    provenance?: string;
  }) {
    const row = {
      id: nextId("pkt"),
      packetCode: input.packetCode,
      status: "ACTIVE",
      shape: input.shape ?? "ROUND",
      sizeLabel: input.sizeLabel ?? "1.0-1.2MM",
      certificateStatus: "NOT_CERTIFIED",
      provenance: input.provenance ?? "PURCHASED",
      currencyCode: "INR",
    };
    base.state.polishedPackets.set(row.id, row);
    const movementId = nextId("pktmov");
    base.state.polishedPacketMovements.set(movementId, {
      id: movementId,
      type: "PURCHASE_IN",
      packetId: row.id,
      pieces: input.pieces,
      carat: input.carat,
      costValue: input.costValue,
      sourceDocument: input.packetCode,
      createdAt: new Date(),
    });
    return row;
  }

  /** Test helper — seed a MetalPurity row directly (bypassing any action-layer validation). */
  function seedMetalPurity(input: { metalType: string; displayName: string; finenessPercent: string; isActive?: boolean }) {
    const row = {
      id: nextId("purity"),
      metalType: input.metalType,
      displayName: input.displayName,
      finenessPercent: input.finenessPercent,
      isActive: input.isActive ?? true,
    };
    metalPurities.set(row.id, row);
    return row;
  }

  /** Test helper — seed an AVAILABLE PolishedDiamond row directly (reuses the diamond fixture's map). */
  function seedPolishedDiamond(input: { polishedCode: string; shape: string; carat: string; allocatedCost: string; status?: string }) {
    const row = {
      id: nextId("pol"),
      status: input.status ?? "AVAILABLE",
      polishedCode: input.polishedCode,
      shape: input.shape,
      carat: input.carat,
      allocatedCost: input.allocatedCost,
      costPerCarat: input.allocatedCost,
    };
    base.state.polishedDiamonds.set(row.id, row);
    return row;
  }

  const tx = {
    ...base.tx,
    jewellerySequence: {
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
        const existing = jewellerySequences.get(key);
        if (existing) {
          existing.lastNumber = (existing.lastNumber as number) + update.lastNumber.increment;
          return existing;
        }
        const row = { id: nextId("jseq"), sequenceType, yearLabel, ...create };
        jewellerySequences.set(key, row);
        return row;
      },
    },
    metalPurity: {
      findUnique: async ({ where }: { where: { id: string } }) => metalPurities.get(where.id) ?? null,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const row = metalPurities.get(where.id);
        if (!row) throw new Error("metal purity not found");
        return row;
      },
      findMany: async ({ where }: { where?: Row } = {}) => {
        const rows = [...metalPurities.values()];
        if (!where) return rows;
        return rows.filter((r) => matchesWhere(r, where));
      },
    },
    metalPurchase: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("mp"), ...data };
        metalPurchases.set(row.id as string, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id?: string; idempotencyKey?: string } }) => {
        if (where.id) return metalPurchases.get(where.id) ?? null;
        return [...metalPurchases.values()].find((r) => r.idempotencyKey === where.idempotencyKey) ?? null;
      },
    },
    metalStockMovement: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("mmov"), ...data };
        metalStockMovements.set(row.id as string, row);
        return row;
      },
      findMany: async ({ where }: { where?: Row } = {}) => {
        const rows = [...metalStockMovements.values()];
        if (!where) return rows;
        return rows.filter((r) => matchesWhere(r, where));
      },
    },
    jewelleryJob: {
      create: async ({ data }: { data: Row }) => {
        const row = {
          id: nextId("jjob"),
          status: "DRAFT",
          issuedMetalFineWeight: "0",
          issuedMetalCost: "0",
          issuedDiamondCost: "0",
          otherMaterialCost: "0",
          remainingWipCost: "0",
          totalLabourCharge: "0",
          receivedFineWeight: "0",
          returnedMetalFineWeight: "0",
          scrapFineWeight: "0",
          karigarAddedFineWeight: "0",
          karigarAddedCost: "0",
          issuedAlloyGrossWeight: "0",
          issuedAlloyCost: "0",
          consumedAlloyGrossWeight: "0",
          returnedAlloyGrossWeight: "0",
          remainingAlloyWipCost: "0",
          wipVoucherId: null,
          ...data,
        };
        jewelleryJobs.set(row.id as string, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => jewelleryJobs.get(where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = jewelleryJobs.get(where.id);
        if (!row) throw new Error("jewellery job not found");
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const rows = [...jewelleryJobs.values()].filter((r) => matchesWhere(r, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },
    jewelleryMetalIssueLine: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("jmil"), createdAt: new Date(), ...data };
        jewelleryMetalIssueLines.set(row.id as string, row);
        return row;
      },
      findFirst: async ({ where }: { where?: Row } = {}) => {
        const rows = [...jewelleryMetalIssueLines.values()]
          .filter((r) => !where || matchesWhere(r, where))
          .sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime());
        return rows[0] ?? null;
      },
      findMany: async ({ where }: { where?: Row } = {}) => {
        const rows = [...jewelleryMetalIssueLines.values()];
        if (!where) return rows;
        return rows.filter((r) => matchesWhere(r, where));
      },
    },
    jewelleryDiamondIssueLine: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("jdil"), resolvedAs: null, ...data };
        jewelleryDiamondIssueLines.set(row.id as string, row);
        return row;
      },
      findMany: async ({ where }: { where?: Row } = {}) => {
        const rows = [...jewelleryDiamondIssueLines.values()];
        if (!where) return rows;
        return rows.filter((r) => matchesWhere(r, where));
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = jewelleryDiamondIssueLines.get(where.id);
        if (!row) throw new Error("jewellery diamond issue line not found");
        Object.assign(row, data);
        return row;
      },
      count: async ({ where }: { where?: Row } = {}) => {
        const rows = [...jewelleryDiamondIssueLines.values()];
        return (where ? rows.filter((r) => matchesWhere(r, where)) : rows).length;
      },
    },
    jewelleryOtherMaterialLine: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("joml"), ...data };
        jewelleryOtherMaterialLines.set(row.id as string, row);
        return row;
      },
      findMany: async ({ where }: { where?: Row } = {}) => {
        const rows = [...jewelleryOtherMaterialLines.values()];
        if (!where) return rows;
        return rows.filter((r) => matchesWhere(r, where));
      },
    },
    jewelleryReceipt: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("jrec"), ...data };
        jewelleryReceipts.set(row.id as string, row);
        return row;
      },
      findUnique: async (args: { where: { id?: string; idempotencyKey?: string }; include?: { outputs?: boolean } }) => {
        const { where, include } = args;
        const row = where.id
          ? jewelleryReceipts.get(where.id)
          : [...jewelleryReceipts.values()].find((r) => r.idempotencyKey === where.idempotencyKey);
        if (!row) return null;
        if (include?.outputs) {
          return { ...row, outputs: [...finishedJewelleryRows.values()].filter((f) => f.receiptId === row.id) };
        }
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = jewelleryReceipts.get(where.id);
        if (!row) throw new Error("jewellery receipt not found");
        Object.assign(row, data);
        return row;
      },
      count: async ({ where }: { where?: Row } = {}) => {
        const rows = [...jewelleryReceipts.values()];
        return (where ? rows.filter((r) => matchesWhere(r, where)) : rows).length;
      },
    },
    finishedJewellery: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("fj"), status: "AVAILABLE", ...data };
        finishedJewelleryRows.set(row.id as string, row);
        return row;
      },
      findUnique: async (args: { where: { id: string }; include?: { job?: boolean; purity?: boolean } }) => {
        const row = finishedJewelleryRows.get(args.where.id);
        if (!row) return null;
        return resolveFinishedJewelleryIncludes(row, args.include);
      },
      findMany: async ({ where }: { where?: Row } = {}) => {
        const rows = [...finishedJewelleryRows.values()];
        if (!where) return rows;
        return rows.filter((r) => matchesWhere(r, where));
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = finishedJewelleryRows.get(where.id);
        if (!row) throw new Error("finished jewellery not found");
        Object.assign(row, data);
        return row;
      },
      // Mirrors the real conditional-UPDATE double-sale-prevention pattern
      // (see FinishedJewellery.status header comment in schema.prisma):
      // only rows matching the WHERE (including status) get updated, and
      // the returned count is the caller's sole signal of success.
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const rows = [...finishedJewelleryRows.values()].filter((r) => matchesWhere(r, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },
    jewelleryPacketIssueLine: {
      create: async ({ data }: { data: Row }) => {
        const row = {
          id: nextId("jpil"),
          setPieces: 0,
          setCarat: "0",
          setCost: "0",
          returnedPieces: 0,
          returnedCarat: "0",
          returnedCost: "0",
          damagedPieces: 0,
          damagedCarat: "0",
          damagedCost: "0",
          ...data,
        };
        jewelleryPacketIssueLines.set(row.id as string, row);
        return row;
      },
      findMany: async ({ where }: { where?: Row } = {}) => {
        const rows = [...jewelleryPacketIssueLines.values()];
        if (!where) return rows;
        return rows.filter((r) => matchesWhere(r, where));
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = jewelleryPacketIssueLines.get(where.id);
        if (!row) throw new Error("jewellery packet issue line not found");
        return applyData(row, data);
      },
    },
    jewelleryPacketResolution: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("jpres"), ...data };
        jewelleryPacketResolutions.set(row.id as string, row);
        return row;
      },
      findMany: async ({ where }: { where?: Row } = {}) => {
        const rows = [...jewelleryPacketResolutions.values()];
        if (!where) return rows;
        return rows.filter((r) => matchesWhere(r, where));
      },
    },
    finishedJewelleryStockMovement: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("fjmov"), createdAt: new Date(), ...data };
        finishedJewelleryStockMovements.set(row.id as string, row);
        return row;
      },
      findFirst: async ({ where, orderBy }: { where?: Row; orderBy?: { createdAt: "asc" | "desc" } } = {}) => {
        let rows = [...finishedJewelleryStockMovements.values()];
        if (where) rows = rows.filter((r) => matchesWhere(r, where));
        rows.sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime());
        if (orderBy?.createdAt === "desc") rows.reverse();
        return rows[0] ?? null;
      },
      findMany: async ({ where }: { where?: Row } = {}) => {
        const rows = [...finishedJewelleryStockMovements.values()];
        if (!where) return rows;
        return rows.filter((r) => matchesWhere(r, where));
      },
    },
  };

  function resolveFinishedJewelleryIncludes(row: Row, include?: { job?: boolean; purity?: boolean }) {
    if (!include) return row;
    const resolved: Row = { ...row };
    if (include.job) resolved.job = jewelleryJobs.get(row.jobId as string) ?? null;
    if (include.purity) resolved.purity = metalPurities.get(row.purityId as string) ?? null;
    return resolved;
  }

  return {
    tx,
    state: {
      ...base.state,
      jewellerySequences,
      metalPurities,
      metalPurchases,
      metalStockMovements,
      jewelleryJobs,
      jewelleryMetalIssueLines,
      jewelleryDiamondIssueLines,
      jewelleryOtherMaterialLines,
      jewelleryReceipts,
      finishedJewelleryRows,
      finishedJewelleryStockMovements,
      jewelleryPacketIssueLines,
      jewelleryPacketResolutions,
    },
    paymentAccountIdByMethod: base.paymentAccountIdByMethod,
    seedParty: base.seedParty,
    seedMetalPurity,
    seedPolishedDiamond,
    seedPolishedPacket,
  };
}

export type FakeJewelleryTx = ReturnType<typeof createFakeJewelleryTx>;
