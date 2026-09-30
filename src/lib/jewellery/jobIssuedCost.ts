import { Decimal, type DecimalInput, round2 } from "@/lib/accounting/money";

/**
 * A Jewellery Job's manufacturing cost, in three parts that add up exactly once:
 *
 *   materials subtotal  = metal issued (fine-bearing metal AND Company
 *                         Copper/Alloy -- issuedMetalCost already holds both;
 *                         issuedAlloyCost is only the alloy share of it, so it
 *                         is never added again) + diamonds + packet stones
 *                         (issued from stock or used from a Job Manufacturer
 *                         return) + other material
 *   Karigar-supplied    = Karigar-added metal/material + Karigar alloy charges
 *                         (recorded at receipt; payable to the Karigar)
 *   charges             = labour + making + setting + plating + other expense,
 *                         at receipt and added later (totalLabourCharge, which
 *                         receipt charge corrections increment and reversals
 *                         decrement)
 *   total manufacturing = materials subtotal + Karigar-supplied + charges
 *
 * Every screen that shows a job's cost (job list, job detail) goes through
 * this one function, so they always agree. Before, the "total" shown was the
 * materials subtotal alone: charges and Karigar-supplied cost were left out,
 * although the ledger, the finished pieces and the Karigar payable include them.
 */
export type JobCostInput = {
  issuedMetalCost: DecimalInput;
  issuedDiamondCost: DecimalInput;
  issuedPacketDiamondCost: DecimalInput;
  otherMaterialCost: DecimalInput;
  karigarAddedCost: DecimalInput;
  totalLabourCharge: DecimalInput;
};

export type JobManufacturingCost = {
  issuedDiamondCost: Decimal;
  materialsSubtotal: Decimal;
  karigarSuppliedCost: Decimal;
  chargesTotal: Decimal;
  totalManufacturingCost: Decimal;
};

/** `karigarAlloyCost`: the sum of the job's receipts' Karigar alloy charges (kept on the receipts, not the job). */
export function jobManufacturingCost(job: JobCostInput, karigarAlloyCost: DecimalInput): JobManufacturingCost {
  const issuedDiamondCost = round2(new Decimal(job.issuedDiamondCost).plus(job.issuedPacketDiamondCost));
  const materialsSubtotal = round2(new Decimal(job.issuedMetalCost).plus(issuedDiamondCost).plus(job.otherMaterialCost));
  const karigarSuppliedCost = round2(new Decimal(job.karigarAddedCost).plus(karigarAlloyCost));
  const chargesTotal = round2(job.totalLabourCharge);
  const totalManufacturingCost = round2(materialsSubtotal.plus(karigarSuppliedCost).plus(chargesTotal));
  return { issuedDiamondCost, materialsSubtotal, karigarSuppliedCost, chargesTotal, totalManufacturingCost };
}
