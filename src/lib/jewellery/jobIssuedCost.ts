import { Decimal, type DecimalInput, round2 } from "@/lib/accounting/money";

/**
 * What a Jewellery Job has been issued, in cost. Stones reach a job two ways:
 * individually costed Phase 3 diamonds (issuedDiamondCost) and Phase 7 polished
 * packets, issued from stock or used from a Job Manufacturer return
 * (issuedPacketDiamondCost). Both are diamond cost issued, and both are part of
 * the total manufacturing cost issued.
 */
export function jobIssuedCosts(job: {
  issuedMetalCost: DecimalInput;
  issuedDiamondCost: DecimalInput;
  issuedPacketDiamondCost: DecimalInput;
  otherMaterialCost: DecimalInput;
}): { issuedDiamondCost: Decimal; totalIssuedCost: Decimal } {
  const issuedDiamondCost = round2(new Decimal(job.issuedDiamondCost).plus(job.issuedPacketDiamondCost));
  const totalIssuedCost = round2(new Decimal(job.issuedMetalCost).plus(issuedDiamondCost).plus(job.otherMaterialCost));
  return { issuedDiamondCost, totalIssuedCost };
}
