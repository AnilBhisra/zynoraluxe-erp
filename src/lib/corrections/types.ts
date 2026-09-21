import type { Prisma } from "@/generated/prisma/client";
import type {
  CorrectionEntityType,
  CorrectionImpactKind,
  CorrectionMode,
  MetalRevaluationTarget,
  MetalType,
} from "@/generated/prisma/enums";
import type { JournalLineInput } from "@/lib/accounting/posting";
import type { DecimalInput } from "@/lib/accounting/money";

export type Tx = Prisma.TransactionClient;

export class CorrectionError extends Error {}

/** A record that already consumed the value being corrected. */
export type DownstreamUse = {
  kind: CorrectionImpactKind;
  tableName: string;
  recordId: string;
  recordLabel: string;
  /** Plain-language description, shown to the Owner in the preview. */
  description: string;
};

export type PlannedImpact = {
  kind: CorrectionImpactKind;
  tableName: string;
  recordId: string;
  recordLabel: string;
  field: string;
  oldValue: string;
  newValue: string;
};

export type PlannedRevaluation = {
  target: MetalRevaluationTarget;
  metalType: MetalType;
  purityId: string;
  grossWeight: string;
  fineWeight: string;
  oldCostValue: string;
  newCostValue: string;
  deltaCostValue: string;
  jewelleryJobId?: string | null;
  finishedJewelleryId?: string | null;
  sourceMovementId?: string | null;
};

/**
 * Everything needed to show the Owner a preview and then post it. A plan is
 * computed without writing anything, stored verbatim on the Correction, and
 * recomputed at approval time so a stale preview can never be posted.
 */
export type CorrectionPlan = {
  entityType: CorrectionEntityType;
  entityId: string;
  entityLabel: string;
  mode: CorrectionMode;
  reason: string;
  originalSnapshot: Record<string, unknown>;
  correctedSnapshot: Record<string, unknown>;
  downstream: DownstreamUse[];
  impacts: PlannedImpact[];
  /** Balanced compensating entry. Empty when the correction posts no voucher. */
  ledgerLines: JournalLineInput[];
  /** Voucher amount; must equal the total debit of `ledgerLines`. */
  amount: string;
  voucherNote: string;
  revaluations: PlannedRevaluation[];
};

/** The comparable shape of a plan — what approval is checked against. */
export type PlanFingerprint = {
  amount: string;
  ledger: string[];
  impacts: string[];
};

export function fingerprintPlan(plan: CorrectionPlan): PlanFingerprint {
  const money = (v: DecimalInput | undefined) => (v === undefined ? "0.00" : String(v));
  return {
    amount: plan.amount,
    ledger: plan.ledgerLines
      .map((l) => `${l.accountCode}|${money(l.debit)}|${money(l.credit)}`)
      .sort(),
    impacts: plan.impacts
      .map((i) => `${i.tableName}|${i.recordId}|${i.field}|${i.oldValue}|${i.newValue}`)
      .sort(),
  };
}
