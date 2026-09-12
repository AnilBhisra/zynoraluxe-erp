import type { Metadata } from "next";

import { requireOwner } from "@/lib/auth/dal";
import { prisma } from "@/lib/db/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import { getCostSheetDetail, getCostingSettings, listCostSheets } from "@/lib/costing/reports";
import { listEligibleFinishedJewelleryOutputs } from "@/lib/costing/sourcing";
import { getCustomerQuotationView } from "@/lib/costing/quotation";
import { resolveJewelleryAssetUrl } from "@/lib/storage/jewelleryMedia";
import { CostSheetsTab } from "@/components/costing/CostSheetsTab";
import { NewCostingTab } from "@/components/costing/NewCostingTab";
import { CostingSettingsTab } from "@/components/costing/CostingSettingsTab";
import { CostSheetDetailView } from "@/components/costing/CostSheetDetailView";
import { QuotationPrintView } from "@/components/costing/QuotationPrintView";

export const metadata: Metadata = {
  title: "Costing · ZYNORALUXE",
};

type SearchParams = {
  tab?: string;
  view?: string;
  search?: string;
  status?: string;
  mode?: string;
  sheetId?: string;
  newMode?: string;
  quotation?: string;
};

const TABS = ["sheets", "new", "settings"] as const;
type Tab = (typeof TABS)[number];

function TabLink({ tab, label, active }: { tab: Tab; label: string; active: boolean }) {
  return (
    <a
      href={`/costing?tab=${tab}`}
      aria-current={active ? "page" : undefined}
      className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
        active
          ? "bg-zinc-900 text-white dark:bg-amber-200 dark:text-zinc-900"
          : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
      }`}
    >
      {label}
    </a>
  );
}

export default async function CostingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  // Owner-only, enforced server-side against the database — Staff are
  // redirected to /unauthorized before any Costing figure is fetched or
  // rendered. Never depend only on the hidden nav item.
  await requireOwner();

  const params = await searchParams;
  const tab: Tab = TABS.includes(params.tab as Tab) ? (params.tab as Tab) : "sheets";

  return (
    <div>
      <PageHeader
        title="Costing"
        description="Work out the real cost of a finished piece, or put together a quotation before you start making it."
      />

      <nav aria-label="Costing sections" className="mb-6 flex flex-wrap gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1.5">
        <TabLink tab="sheets" label="Cost Sheets" active={tab === "sheets"} />
        <TabLink tab="new" label="New Costing" active={tab === "new"} />
        <TabLink tab="settings" label="Costing Settings" active={tab === "settings"} />
      </nav>

      {tab === "sheets" ? (
        <SheetsTabContent
          search={params.search ?? ""}
          status={params.status ?? "ACTIVE"}
          mode={params.mode ?? "ALL"}
          sheetId={params.sheetId ?? ""}
          quotation={params.quotation === "1"}
        />
      ) : null}
      {tab === "new" ? <NewCostingTabContent newMode={params.newMode ?? ""} /> : null}
      {tab === "settings" ? <SettingsTabContent /> : null}
    </div>
  );
}

async function SheetsTabContent({
  search,
  status,
  mode,
  sheetId,
  quotation,
}: {
  search: string;
  status: string;
  mode: string;
  sheetId: string;
  quotation: boolean;
}) {
  if (sheetId && quotation) {
    const quotationView = await getCustomerQuotationView(sheetId);
    if (!quotationView) {
      return (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          No quotation is available — this costing may not be Finalized yet.
        </p>
      );
    }
    const [designImageUrl, companySettings] = await Promise.all([
      resolveJewelleryAssetUrl((await getCostSheetDetail(sheetId))?.designImageAssetId ?? null),
      prisma.companySettings.findUnique({ where: { id: "default" } }),
    ]);
    return (
      <QuotationPrintView
        quotation={{
          ...quotationView,
          costingDate: quotationView.costingDate.toISOString(),
          quotationValidUntil: quotationView.quotationValidUntil ? quotationView.quotationValidUntil.toISOString() : null,
          metalSummary: quotationView.metalSummary.map((m) => ({ ...m, grossWeight: m.grossWeight.toFixed(3) })),
          diamondSummary: quotationView.diamondSummary.map((d) => ({ ...d, totalCarat: d.totalCarat.toFixed(3) })),
          sellingValueBeforeDiscount: quotationView.sellingValueBeforeDiscount.toFixed(2),
          discountAmount: quotationView.discountAmount.toFixed(2),
          taxableSellingValue: quotationView.taxableSellingValue.toFixed(2),
          gstRatePercent: quotationView.gstRatePercent.toFixed(2),
          cgst: quotationView.cgst.toFixed(2),
          sgst: quotationView.sgst.toFixed(2),
          igst: quotationView.igst.toFixed(2),
          customerTotal: quotationView.customerTotal.toFixed(2),
        }}
        designImageUrl={designImageUrl}
        company={{
          name: companySettings?.companyName ?? "",
          address: companySettings?.address ?? null,
          phone: companySettings?.phone ?? null,
          email: companySettings?.email ?? null,
          gstNumber: companySettings?.gstNumber ?? null,
        }}
      />
    );
  }

  if (sheetId) {
    const detail = await getCostSheetDetail(sheetId);
    if (!detail) return <p className="text-sm text-zinc-500 dark:text-zinc-400">Costing not found.</p>;
    const designImageUrl = await resolveJewelleryAssetUrl(detail.designImageAssetId);
    const gstRates = await prisma.gstRate.findMany({ where: { isActive: true }, orderBy: { ratePercent: "asc" } });
    const customers = await prisma.party.findMany({ where: { type: "CUSTOMER", isActive: true }, orderBy: { name: "asc" } });
    const estimates = await listCostSheets({ mode: "ESTIMATE" });
    const purities = await prisma.metalPurity.findMany({ where: { isActive: true }, orderBy: { displayName: "asc" } });

    return (
      <CostSheetDetailView
        detail={serializeDetail(detail) as never}
        designImageUrl={designImageUrl}
        gstRates={gstRates.map((g) => ({ id: g.id, label: g.label, ratePercent: g.ratePercent.toString() }))}
        customers={customers.map((c) => ({ id: c.id, name: c.name }))}
        estimateOptions={estimates.map((e) => ({ id: e.id, costingNumber: e.costingNumber, itemName: e.itemName }))}
        purities={purities.map((p) => ({ id: p.id, metalType: p.metalType, displayName: p.displayName, finenessPercent: p.finenessPercent.toString() }))}
      />
    );
  }

  const statusList =
    status === "DRAFT"
      ? (["DRAFT"] as const)
      : status === "FINALIZED"
        ? (["FINALIZED"] as const)
        : status === "ARCHIVED"
          ? (["ARCHIVED"] as const)
          : status === "ALL"
            ? undefined
            : (["DRAFT", "FINALIZED"] as const);

  const sheets = await listCostSheets({
    mode: mode === "ACTUAL" || mode === "ESTIMATE" ? mode : undefined,
    status: statusList ? [...statusList] : undefined,
    search: search || undefined,
  });

  return (
    <CostSheetsTab
      sheets={sheets.map((s) => ({
        id: s.id,
        costingNumber: s.costingNumber,
        mode: s.mode,
        status: s.status,
        costingDate: s.costingDate.toISOString(),
        itemName: s.itemName,
        customerName: s.customerName,
        referenceNumber: s.referenceNumber,
        revisionNumber: s.revisionNumber,
        productionCost: s.productionCost.toFixed(2),
        customerTotal: s.customerTotal.toFixed(2),
        estimatedProfit: s.estimatedProfit.toFixed(2),
      }))}
      search={search}
      status={status}
      mode={mode}
    />
  );
}

async function NewCostingTabContent({ newMode }: { newMode: string }) {
  const [outputs, purities, gstRates, customers, settings] = await Promise.all([
    listEligibleFinishedJewelleryOutputs(),
    prisma.metalPurity.findMany({ where: { isActive: true }, orderBy: { displayName: "asc" } }),
    prisma.gstRate.findMany({ where: { isActive: true }, orderBy: { ratePercent: "asc" } }),
    prisma.party.findMany({ where: { type: "CUSTOMER", isActive: true }, orderBy: { name: "asc" } }),
    getCostingSettings(),
  ]);

  return (
    <NewCostingTab
      initialMode={newMode === "actual" ? "actual" : newMode === "estimate" ? "estimate" : null}
      eligibleOutputs={outputs.map((o) => ({
        id: o.id,
        finishedCode: o.finishedCode,
        jobCode: o.jobCode,
        designName: o.designName,
        jewelleryType: o.jewelleryType,
        customerName: o.customerName,
        karigarName: o.karigarName,
        quantity: o.quantity,
        netMetalWeight: o.netMetalWeight.toFixed(3),
        purityDisplayName: o.purityDisplayName,
        totalCost: o.totalCost.toFixed(2),
        qcStatus: o.qcStatus,
        receiveDate: o.receiveDate.toISOString(),
      }))}
      purities={purities.map((p) => ({ id: p.id, metalType: p.metalType, displayName: p.displayName, finenessPercent: p.finenessPercent.toString() }))}
      gstRates={gstRates.map((g) => ({ id: g.id, label: g.label, ratePercent: g.ratePercent.toString() }))}
      customers={customers.map((c) => ({ id: c.id, name: c.name }))}
      defaults={{
        pricingMethod: settings.defaultPricingMethod,
        markupPercent: settings.defaultMarkupPercent.toString(),
        targetMarginPercent: settings.defaultTargetMarginPercent.toString(),
        discountType: settings.defaultDiscountType,
        discountValue: settings.defaultDiscountValue.toString(),
        gstTreatment: settings.defaultGstTreatment,
        gstRateId: settings.defaultGstRateId,
        priceType: settings.defaultPriceType,
        roundingStep: settings.defaultRoundingStep.toString(),
        sellingExpenseFixed: settings.defaultSellingExpenseFixed.toString(),
        sellingExpensePercent: settings.defaultSellingExpensePercent.toString(),
      }}
    />
  );
}

async function SettingsTabContent() {
  const settings = await getCostingSettings();
  const gstRates = await prisma.gstRate.findMany({ where: { isActive: true }, orderBy: { ratePercent: "asc" } });
  return (
    <CostingSettingsTab
      initialValues={{
        defaultPricingMethod: settings.defaultPricingMethod,
        defaultMarkupPercent: settings.defaultMarkupPercent.toString(),
        defaultTargetMarginPercent: settings.defaultTargetMarginPercent.toString(),
        defaultDiscountType: settings.defaultDiscountType,
        defaultDiscountValue: settings.defaultDiscountValue.toString(),
        defaultGstTreatment: settings.defaultGstTreatment,
        defaultGstRateId: settings.defaultGstRateId ?? "",
        defaultPriceType: settings.defaultPriceType,
        defaultValidityDays: String(settings.defaultValidityDays),
        defaultRoundingStep: settings.defaultRoundingStep.toString(),
        defaultSellingExpenseFixed: settings.defaultSellingExpenseFixed.toString(),
        defaultSellingExpensePercent: settings.defaultSellingExpensePercent.toString(),
        quotationTerms: settings.quotationTerms ?? "",
      }}
      gstRates={gstRates.map((g) => ({ id: g.id, label: g.label, ratePercent: g.ratePercent.toString() }))}
    />
  );
}

function serializeDetail(detail: Awaited<ReturnType<typeof getCostSheetDetail>>) {
  if (!detail) return detail;
  return {
    ...detail,
    costingDate: detail.costingDate.toISOString(),
    sourceRefreshedAt: detail.sourceRefreshedAt ? detail.sourceRefreshedAt.toISOString() : null,
    quotationValidUntil: detail.quotationValidUntil ? detail.quotationValidUntil.toISOString() : null,
    finalizedAt: detail.finalizedAt ? detail.finalizedAt.toISOString() : null,
    archivedAt: detail.archivedAt ? detail.archivedAt.toISOString() : null,
    createdAt: detail.createdAt.toISOString(),
    markupPercent: detail.markupPercent.toString(),
    targetMarginPercent: detail.targetMarginPercent.toString(),
    manualSellingPriceOverride: detail.manualSellingPriceOverride ? detail.manualSellingPriceOverride.toString() : null,
    discountValue: detail.discountValue.toString(),
    gstRatePercentSnapshot: detail.gstRatePercentSnapshot.toString(),
    roundingStep: detail.roundingStep.toString(),
    sellingExpenseFixed: detail.sellingExpenseFixed.toString(),
    sellingExpensePercent: detail.sellingExpensePercent.toString(),
    metalLines: detail.metalLines.map((l) => ({
      ...l,
      finenessPercentSnapshot: l.finenessPercentSnapshot.toString(),
      grossWeight: l.grossWeight.toString(),
      wastagePercent: l.wastagePercent.toString(),
      wastageWeight: l.wastageWeight.toString(),
      fineWeight: l.fineWeight.toString(),
      rate: l.rate.toString(),
      amount: l.amount.toString(),
    })),
    diamondLines: detail.diamondLines.map((l) => ({
      ...l,
      totalCarat: l.totalCarat.toString(),
      ratePerCarat: l.ratePerCarat ? l.ratePerCarat.toString() : null,
      fixedAmount: l.fixedAmount ? l.fixedAmount.toString() : null,
      certificateCharge: l.certificateCharge.toString(),
      amount: l.amount.toString(),
    })),
    otherMaterialLines: detail.otherMaterialLines.map((l) => ({
      ...l,
      quantity: l.quantity ? l.quantity.toString() : null,
      weight: l.weight ? l.weight.toString() : null,
      rate: l.rate ? l.rate.toString() : null,
      amount: l.amount.toString(),
    })),
    chargeLines: detail.chargeLines.map((l) => ({ ...l, rate: l.rate.toString(), amount: l.amount.toString() })),
    totals: {
      metalCost: detail.totals.metalCost.toFixed(2),
      diamondCost: detail.totals.diamondCost.toFixed(2),
      otherMaterialCost: detail.totals.otherMaterialCost.toFixed(2),
      labourCost: detail.totals.labourCost.toFixed(2),
      additionalChargesCost: detail.totals.additionalChargesCost.toFixed(2),
      productionCost: detail.totals.productionCost.toFixed(2),
      sellingValueBeforeDiscount: detail.totals.sellingValueBeforeDiscount.toFixed(2),
      discountAmount: detail.totals.discountAmount.toFixed(2),
      taxableSellingValue: detail.totals.taxableSellingValue.toFixed(2),
      gstAmount: detail.totals.gstAmount.toFixed(2),
      cgst: detail.totals.cgst.toFixed(2),
      sgst: detail.totals.sgst.toFixed(2),
      igst: detail.totals.igst.toFixed(2),
      customerTotalBeforeRounding: detail.totals.customerTotalBeforeRounding.toFixed(2),
      roundingAdjustment: detail.totals.roundingAdjustment.toFixed(2),
      customerTotal: detail.totals.customerTotal.toFixed(2),
      sellingExpenseAmount: detail.totals.sellingExpenseAmount.toFixed(2),
      netRealization: detail.totals.netRealization.toFixed(2),
      estimatedProfit: detail.totals.estimatedProfit.toFixed(2),
      profitMarginPercent: detail.totals.profitMarginPercent.toFixed(2),
      isManualOverrideApplied: detail.totals.isManualOverrideApplied,
    },
    linkedEstimateTotals: detail.linkedEstimateTotals
      ? {
          productionCost: detail.linkedEstimateTotals.productionCost.toFixed(2),
          customerTotal: detail.linkedEstimateTotals.customerTotal.toFixed(2),
          estimatedProfit: detail.linkedEstimateTotals.estimatedProfit.toFixed(2),
          profitMarginPercent: detail.linkedEstimateTotals.profitMarginPercent.toFixed(2),
        }
      : null,
    auditEvents: detail.auditEvents.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
  };
}
