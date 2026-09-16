import { createFakeDiamondTx } from "./fakeDiamondTx";

/**
 * Extends the Phase 3 fake diamond transaction client with the Phase 7
 * Polished Purchase / packet tables (and the Party rows a broker lookup
 * needs), so src/lib/diamond/polishedPurchase.ts's REAL code runs without a
 * database — same layering as fakeJewelleryTx.ts over fakeDiamondTx.ts.
 */

type Row = Record<string, unknown>;

export function createFakePolishedTx() {
  const base = createFakeDiamondTx();

  const parties = new Map<string, Row>();
  const polishedPurchases = new Map<string, Row>();
  const polishedPurchaseLines = new Map<string, Row>();
  const polishedPackets = new Map<string, Row>();
  const polishedPacketMovements = new Map<string, Row>();

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

  /** Test helper — seed a Party (supplier, broker, karigar…). */
  function seedParty(input: { name: string; type: string; isActive?: boolean }) {
    const row = { id: nextId("party"), name: input.name, type: input.type, isActive: input.isActive ?? true };
    parties.set(row.id, row);
    return row;
  }

  function packetWithRelations(row: Row) {
    return { ...row };
  }

  const tx = {
    ...base.tx,
    party: {
      findUnique: async ({ where }: { where: { id: string } }) => parties.get(where.id) ?? null,
    },
    polishedPurchase: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("pp"), status: "POSTED", ...data };
        polishedPurchases.set(row.id as string, row);
        return row;
      },
      findUnique: async (args: {
        where: { id?: string; idempotencyKey?: string };
        include?: { lines?: unknown };
      }) => {
        const row = args.where.id
          ? polishedPurchases.get(args.where.id)
          : [...polishedPurchases.values()].find((p) => p.idempotencyKey === args.where.idempotencyKey);
        if (!row) return null;
        if (!args.include?.lines) return row;
        const lines = [...polishedPurchaseLines.values()]
          .filter((l) => l.purchaseId === row.id)
          .map((line) => ({
            ...line,
            packet: [...polishedPackets.values()].find((p) => p.purchaseLineId === line.id) ?? null,
          }));
        return { ...row, lines };
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = polishedPurchases.get(where.id);
        if (!row) throw new Error("polished purchase not found");
        Object.assign(row, data);
        return row;
      },
    },
    polishedPurchaseLine: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("ppl"), ...data };
        polishedPurchaseLines.set(row.id as string, row);
        return row;
      },
      findMany: async ({ where }: { where?: Row } = {}) => {
        const rows = [...polishedPurchaseLines.values()];
        return where ? rows.filter((r) => matchesWhere(r, where)) : rows;
      },
    },
    polishedPacket: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("pkt"), status: "ACTIVE", ...data };
        polishedPackets.set(row.id as string, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = polishedPackets.get(where.id);
        return row ? packetWithRelations(row) : null;
      },
      findMany: async ({ where }: { where?: Row } = {}) => {
        const rows = [...polishedPackets.values()];
        return where ? rows.filter((r) => matchesWhere(r, where)) : rows;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = polishedPackets.get(where.id);
        if (!row) throw new Error("polished packet not found");
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const rows = [...polishedPackets.values()].filter((r) => matchesWhere(r, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },
    polishedPacketMovement: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("pktmov"), createdAt: new Date(), ...data };
        polishedPacketMovements.set(row.id as string, row);
        return row;
      },
      findMany: async ({ where }: { where?: Row } = {}) => {
        const rows = [...polishedPacketMovements.values()];
        return where ? rows.filter((r) => matchesWhere(r, where)) : rows;
      },
      findFirst: async ({ where }: { where?: Row } = {}) => {
        const rows = [...polishedPacketMovements.values()];
        return (where ? rows.filter((r) => matchesWhere(r, where)) : rows)[0] ?? null;
      },
    },
  };

  return {
    tx,
    state: {
      ...base.state,
      parties,
      polishedPurchases,
      polishedPurchaseLines,
      polishedPackets,
      polishedPacketMovements,
    },
    paymentAccountIdByMethod: base.paymentAccountIdByMethod,
    seedParty,
    seedDiamondProcess: base.seedDiamondProcess,
  };
}

export type FakePolishedTx = ReturnType<typeof createFakePolishedTx>;
