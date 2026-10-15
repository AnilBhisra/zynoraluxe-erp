/**
 * Recreates a pre-stock, free-text Other Material entry exactly as it exists
 * in historical data (a JewelleryOtherMaterialLine plus the job's display-only
 * otherMaterialCost). The app can no longer issue such entries — they must be
 * purchased first — but jobs that already have them must keep behaving the
 * same, so the tests that cover that history seed it with this helper.
 */
type Delegates = {
  jewelleryOtherMaterialLine: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
  jewelleryJob: {
    findUnique: (args: { where: { id: string } }) => Promise<{ otherMaterialCost: unknown } | null>;
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
  };
};

export async function seedLegacyOtherMaterial(
  tx: unknown,
  input: { jobId: string; description: string; quantity: number | string; unit: "PCS" | "CT" | "GRAM" | "OTHER"; cost: number | string; createdByUserId: string }
) {
  const t = tx as Delegates;
  const cost = Number(input.cost).toFixed(2);
  await t.jewelleryOtherMaterialLine.create({
    data: { jobId: input.jobId, description: input.description, quantity: Number(input.quantity).toFixed(3), unit: input.unit, weight: null, cost, note: null, createdByUserId: input.createdByUserId },
  });
  const job = await t.jewelleryJob.findUnique({ where: { id: input.jobId } });
  const current = Number(String(job?.otherMaterialCost ?? 0));
  return t.jewelleryJob.update({ where: { id: input.jobId }, data: { otherMaterialCost: (current + Number(cost)).toFixed(2) } });
}
