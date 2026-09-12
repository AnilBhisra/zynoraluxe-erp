import { createFakeJewelleryTx } from "./fakeJewelleryTx";

/**
 * Extends the Phase 4 fake jewellery transaction client with the Phase 6
 * Finished Jewellery Sale/Return tables, so src/lib/jewellery/
 * finishedSalesPosting.ts's REAL code (postFinishedJewellerySale,
 * cancelFinishedJewellerySale, returnFinishedJewelleryItems,
 * adjustFinishedJewelleryStock) can be exercised without a live database —
 * mirroring the same layering fakeJewelleryTx.ts/fakeDiamondTx.ts use.
 */

type Row = Record<string, unknown>;

export function createFakeFinishedSalesTx() {
  const base = createFakeJewelleryTx();

  const finishedJewellerySales = new Map<string, Row>();
  const finishedJewellerySaleLines = new Map<string, Row>();
  const finishedJewelleryReturns = new Map<string, Row>();
  const finishedJewelleryReturnLines = new Map<string, Row>();

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

  function resolveSaleLineIncludes(row: Row, include?: { finishedJewellery?: { include?: { job?: boolean; purity?: boolean } } }) {
    if (!include?.finishedJewellery) return row;
    const fj = base.state.finishedJewelleryRows.get(row.finishedJewelleryId as string);
    if (!fj) return { ...row, finishedJewellery: null };
    const fjInclude = include.finishedJewellery.include;
    const resolvedFj: Row = { ...fj };
    if (fjInclude?.job) resolvedFj.job = base.state.jewelleryJobs.get(fj.jobId as string) ?? null;
    if (fjInclude?.purity) resolvedFj.purity = base.state.metalPurities.get(fj.purityId as string) ?? null;
    return { ...row, finishedJewellery: resolvedFj };
  }

  const tx = {
    ...base.tx,
    finishedJewellerySale: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("fjs"), status: "POSTED", ...data };
        finishedJewellerySales.set(row.id as string, row);
        return row;
      },
      findUnique: async (args: {
        where: { id?: string; idempotencyKey?: string };
        include?: { lines?: { include?: { finishedJewellery?: { include?: { job?: boolean; purity?: boolean } } } } };
      }) => {
        const { where, include } = args;
        const row = where.id
          ? finishedJewellerySales.get(where.id)
          : [...finishedJewellerySales.values()].find((r) => r.idempotencyKey === where.idempotencyKey);
        if (!row) return null;
        if (include?.lines) {
          const lines = [...finishedJewellerySaleLines.values()]
            .filter((l) => l.saleId === row.id)
            .sort((a, b) => (a.sortOrder as number) - (b.sortOrder as number))
            .map((l) => resolveSaleLineIncludes(l, include.lines!.include));
          return { ...row, lines };
        }
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = finishedJewellerySales.get(where.id);
        if (!row) throw new Error("finished jewellery sale not found");
        Object.assign(row, data);
        return row;
      },
    },
    finishedJewellerySaleLine: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("fjsl"), returnStatus: "NONE", createdAt: new Date(), ...data };
        finishedJewellerySaleLines.set(row.id as string, row);
        return row;
      },
      findMany: async (args: {
        where?: Row;
        include?: { finishedJewellery?: { include?: { job?: boolean; purity?: boolean } } };
      } = {}) => {
        const { where, include } = args;
        let rows = [...finishedJewellerySaleLines.values()];
        if (where) rows = rows.filter((r) => matchesWhere(r, where));
        return rows.map((r) => resolveSaleLineIncludes(r, include));
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = finishedJewellerySaleLines.get(where.id);
        if (!row) throw new Error("finished jewellery sale line not found");
        Object.assign(row, data);
        return row;
      },
    },
    finishedJewelleryReturn: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("fjr"), ...data };
        finishedJewelleryReturns.set(row.id as string, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id?: string; idempotencyKey?: string } }) => {
        if (where.id) return finishedJewelleryReturns.get(where.id) ?? null;
        return [...finishedJewelleryReturns.values()].find((r) => r.idempotencyKey === where.idempotencyKey) ?? null;
      },
    },
    finishedJewelleryReturnLine: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("fjrl"), ...data };
        finishedJewelleryReturnLines.set(row.id as string, row);
        return row;
      },
      findMany: async ({ where }: { where?: Row } = {}) => {
        const rows = [...finishedJewelleryReturnLines.values()];
        if (!where) return rows;
        return rows.filter((r) => matchesWhere(r, where));
      },
    },
  };

  return {
    tx,
    state: {
      ...base.state,
      finishedJewellerySales,
      finishedJewellerySaleLines,
      finishedJewelleryReturns,
      finishedJewelleryReturnLines,
    },
    paymentAccountIdByMethod: base.paymentAccountIdByMethod,
    seedMetalPurity: base.seedMetalPurity,
    seedPolishedDiamond: base.seedPolishedDiamond,
  };
}

export type FakeFinishedSalesTx = ReturnType<typeof createFakeFinishedSalesTx>;
