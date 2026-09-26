import "server-only";

import type { Prisma } from "@/generated/prisma/client";

import { Decimal } from "@/lib/accounting/money";
import { PostingError } from "@/lib/accounting/posting";
import { nextDiamondCode } from "@/lib/diamond/numbering";
import { buildPacketMergeKey } from "@/lib/diamond/packets";

export { PostingError };

type Tx = Prisma.TransactionClient;

export const MIN_CONVERSION_REASON_LENGTH = 10;

/**
 * Audited Owner conversion of an EXISTING single-stone polished row (a ZL-POL
 * record) that actually represents a parcel of many stones.
 *
 * Nothing converts implicitly: a polished row is a single stone unless an
 * Owner says otherwise here, with the stone count and a written reason. The
 * row is retired (CONVERTED_TO_PARCEL) but kept, and its carat and CURRENT
 * carrying cost (`allocatedCost`, i.e. after any allocation override) move
 * into a PolishedPacket on the packet ledger — where a Jewellery Job can take
 * part of it, and where return / cancellation already work. It is a pure
 * reclassification inside 1220 Polished Diamond Inventory, so no voucher is
 * posted and no value is created or lost.
 *
 * Refused when the row is not Available (issued, set, recut, lost, already
 * converted), or is certified — a certified stone is a single stone.
 */
export async function convertPolishedDiamondToParcel(
  tx: Tx,
  input: {
    polishedDiamondId: string;
    pieceCount: number;
    sizeLabel?: string | null;
    reason: string;
    convertedByUserId: string;
  }
) {
  const reason = input.reason?.trim() ?? "";
  if (reason.length < MIN_CONVERSION_REASON_LENGTH) {
    throw new PostingError(
      `Say why this record is a parcel of many stones (at least ${MIN_CONVERSION_REASON_LENGTH} characters) — the reason is kept in the audit trail.`
    );
  }
  if (!Number.isInteger(input.pieceCount) || input.pieceCount < 2) {
    throw new PostingError("Enter how many stones the parcel holds — at least 2. A single stone stays a single stone.");
  }

  // Lock the row so two people converting (or one converting while another
  // issues it) serialise; the second sees the new status and is refused.
  await tx.$queryRawUnsafe(`SELECT id FROM "polished_diamonds" WHERE id = $1 FOR UPDATE`, input.polishedDiamondId);

  const diamond = await tx.polishedDiamond.findUnique({
    where: { id: input.polishedDiamondId },
    include: { job: { select: { jobCode: true } }, receipt: { select: { receiptCode: true } }, convertedToPacket: { select: { packetCode: true } } },
  });
  if (!diamond) throw new PostingError("Polished diamond not found.");
  if (diamond.status === "CONVERTED_TO_PARCEL") {
    throw new PostingError(
      `${diamond.polishedCode} has already been converted to parcel ${diamond.convertedToPacket?.packetCode ?? ""}.`.replace(" .", ".")
    );
  }
  if (diamond.status !== "AVAILABLE") {
    throw new PostingError(`${diamond.polishedCode} is not available (current status: ${diamond.status}) — only an Available record can be converted.`);
  }
  if (diamond.certificateStatus !== "NOT_CERTIFIED" || diamond.certNumber || diamond.certLab || diamond.certFileAssetId) {
    throw new PostingError(`${diamond.polishedCode} is certified, so it is a single stone and cannot be converted to a parcel.`);
  }

  const carat = new Decimal(diamond.carat);
  const cost = new Decimal(diamond.allocatedCost);
  const sizeLabel = input.sizeLabel?.trim() || "Unsized";

  const packetCode = await nextDiamondCode(tx, "POLISHED_PACKET");
  const packet = await tx.polishedPacket.create({
    data: {
      packetCode,
      provenance: "MANUFACTURED_FROM_ROUGH",
      mergeKey: buildPacketMergeKey({
        shape: diamond.shape,
        sizeLabel,
        quality: diamond.clarity,
        colour: diamond.color,
        lab: null,
        certificateStatus: "NOT_CERTIFIED",
        provenance: "MANUFACTURED_FROM_ROUGH",
        currencyCode: "INR",
      }),
      shape: diamond.shape,
      sizeLabel,
      quality: diamond.clarity,
      colour: diamond.color,
      certificateStatus: "NOT_CERTIFIED",
      photoAssetId: diamond.photoAssetId,
      currencyCode: "INR",
      sourceDiamondJobId: diamond.jobId,
      sourceReceiptId: diamond.receiptId,
      convertedFromPolishedDiamondId: diamond.id,
      notes: `Converted from ${diamond.polishedCode} (job ${diamond.job.jobCode}, receipt ${diamond.receipt.receiptCode}) — ${reason}`,
      createdByUserId: input.convertedByUserId,
    },
  });

  await tx.polishedPacketMovement.create({
    data: {
      type: "CONVERSION_IN",
      packetId: packet.id,
      pieces: input.pieceCount,
      carat: carat.toFixed(3),
      costValue: cost.toFixed(2),
      sourceDocument: diamond.polishedCode,
      createdByUserId: input.convertedByUserId,
    },
  });

  await tx.stockMovement.create({
    data: {
      type: "POLISHED_CONVERTED_OUT",
      polishedDiamondId: diamond.id,
      diamondJobId: diamond.jobId,
      pieces: 1,
      carat: carat.toFixed(3),
      costValue: cost.toFixed(2),
      sourceDocument: packetCode,
      createdByUserId: input.convertedByUserId,
    },
  });

  const retired = await tx.polishedDiamond.update({
    where: { id: diamond.id },
    data: {
      status: "CONVERTED_TO_PARCEL",
      convertedAt: new Date(),
      convertedByUserId: input.convertedByUserId,
      convertedReason: reason,
    },
  });

  return { packet, diamond: retired };
}
