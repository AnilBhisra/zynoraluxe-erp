import { createFakeJewelleryTx } from "./fakeJewelleryTx";

/**
 * Extends the jewellery fixture (which already layers polished packets,
 * diamond jobs and accounting) with the Phase 7 Job Manufacturer tables, so
 * src/lib/diamond/packetProcess.ts's REAL code runs without a database —
 * including stones marked "used in Jewellery Job", which need the jewellery
 * tables underneath.
 */

type Row = Record<string, unknown>;

export function createFakePacketProcessTx() {
  const base = createFakeJewelleryTx();

  const packetProcessJobs = new Map<string, Row>();
  const packetProcessJobLines = new Map<string, Row>();
  const packetProcessReceipts = new Map<string, Row>();
  const packetProcessReceiptLines = new Map<string, Row>();

  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-${++counter}`;
  const matches = (row: Row, where?: Row) =>
    !where || Object.entries(where).every(([key, value]) => value === undefined || row[key] === value);

  function table(map: Map<string, Row>, prefix: string, defaults: Row = {}) {
    return {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId(prefix), createdAt: new Date(), ...defaults, ...data };
        map.set(row.id as string, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
        (where.id ? map.get(where.id) : [...map.values()].find((r) => r.idempotencyKey === where.idempotencyKey)) ?? null,
      findMany: async ({ where }: { where?: Row } = {}) => [...map.values()].filter((r) => matches(r, where)),
      count: async ({ where }: { where?: Row } = {}) => [...map.values()].filter((r) => matches(r, where)).length,
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = map.get(where.id);
        if (!row) throw new Error(`${prefix} not found`);
        Object.assign(row, data);
        return row;
      },
    };
  }

  const tx = {
    ...base.tx,
    packetProcessJob: table(packetProcessJobs, "ppj", {
      status: "ISSUED",
      returnedPieces: 0,
      returnedCarat: "0",
      usedPieces: 0,
      usedCarat: "0",
      damagedPieces: 0,
      damagedCarat: "0",
      lossCarat: "0",
      totalCharge: "0",
    }),
    packetProcessJobLine: table(packetProcessJobLines, "ppjl", {
      resolvedPieces: 0,
      resolvedCarat: "0",
      lossCarat: "0",
      resolvedCost: "0",
      isClosed: false,
    }),
    packetProcessReceipt: table(packetProcessReceipts, "ppr"),
    packetProcessReceiptLine: table(packetProcessReceiptLines, "pprl"),
  };

  return {
    ...base,
    tx,
    state: { ...base.state, packetProcessJobs, packetProcessJobLines, packetProcessReceipts, packetProcessReceiptLines },
  };
}

export type FakePacketProcessTx = ReturnType<typeof createFakePacketProcessTx>;
