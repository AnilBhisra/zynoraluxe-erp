"use client";

import { startTransition, useActionState, useEffect, useMemo, useRef, useState } from "react";

import { previewCustomerGoldReceiptAction, previewReceiptCustodyAction, receiveFinishedJewelleryAction } from "@/app/actions/jewellery";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { JewelleryPhotoUploadField } from "@/components/jewellery/PhotoUploadField";
import { JEWELLERY_TYPES, metalTypeLabel } from "@/lib/jewellery/types";
import { computeOutputMetal, fineWeightThousandths, formatThousandths, toThousandths } from "@/lib/jewellery/metalMath";

export type MetalPurityOption = { id: string; metalType: string; displayName: string; finenessPercent: string };
export type UnresolvedDiamondOption = { polishedDiamondId: string; polishedCode: string; shape: string; carat: string };
/** One purity actually issued to this job, with the fineness snapshot taken at issue time. */
/** Phase 7 — packet stones issued to this job that are still with the Karigar. */
export type PendingPacketOption = { packetId: string; packetCode: string; label: string; pendingPieces: number; pendingCarat: string };
type PacketQty = { pieces: string; carat: string };
type PacketResolutionDraft = { set: PacketQty; setOutputIndex: string; returned: PacketQty; damaged: PacketQty; reason: string };
function emptyPacketDraft(): PacketResolutionDraft {
  return { set: { pieces: "", carat: "" }, setOutputIndex: "0", returned: { pieces: "", carat: "" }, damaged: { pieces: "", carat: "" }, reason: "" };
}
/** Exact integer thousandths of a carat entry, so pending checks never drift. */
function ct1000(value: string): number {
  return Math.round((Number(value) || 0) * 1000);
}

export type IssuedMetalOption = {
  purityId: string;
  metalType: string;
  displayName: string;
  finenessPercent: string;
  isAlloy: boolean;
  grossWeight: string;
  fineWeight: string;
};

type OutputDraft = {
  jewelleryType: string;
  description: string;
  quantity: string;
  grossWeight: string;
  netMetalWeight: string;
  metalType: string;
  purityId: string;
  diamondIds: string[];
  photoAssetId: string | null;
  qcStatus: "PASSED" | "NEEDS_CORRECTION" | "REJECTED";
  notes: string;
};

type FinalPurityOption = { id: string; displayName: string; finenessPercent: string; isIssued: boolean };

/**
 * One of the job's Karigar's unallocated Karigar Metal pools that this job can
 * take its gold from at receipt (same metal, purity and fineness as any gold
 * the job already holds). Weights only -- Owner and Staff both get it.
 */
export type CustodySourceOption = {
  purityId: string;
  metalType: string;
  displayName: string;
  finenessPercent: string;
  unallocatedGross: string;
  unallocatedFine: string;
};

type CustodyPreviewState = Awaited<ReturnType<typeof previewReceiptCustodyAction>> | undefined;

/**
 * One of the job's Customer's own gold pools (CUSTOMER_GOLD_DESIGN.md) this
 * job can be received from: the Customer's gold already on this job is used
 * first, then the same Customer's gold with this job's Karigar, then in the
 * safe. Weights only — Customer gold has no Company value.
 */
export type CustomerGoldSourceOption = {
  purityId: string;
  metalType: string;
  displayName: string;
  finenessPercent: string;
  onJobFine: string;
  withKarigarFine: string;
  safeFine: string;
};

type CustomerGoldPreviewState = Awaited<ReturnType<typeof previewCustomerGoldReceiptAction>> | undefined;
const customerKeyOf = (s: CustomerGoldSourceOption) => `${s.purityId}|${s.finenessPercent}`;

/** The job's own metal plus the chosen Karigar Metal pool, as one fine-bearing list. */
function withCustodySource(fineBearing: IssuedMetalOption[], source: CustodySourceOption | null): IssuedMetalOption[] {
  if (!source || fineBearing.some((m) => m.purityId === source.purityId)) return fineBearing;
  return [
    ...fineBearing,
    {
      purityId: source.purityId,
      metalType: source.metalType,
      displayName: source.displayName,
      finenessPercent: source.finenessPercent,
      isAlloy: false,
      grossWeight: "0.000",
      fineWeight: "0.000",
    },
  ];
}

const ZERO = BigInt(0);

function emptyOutput(defaultMetalType: string, defaultPurityId: string, jewelleryType: string): OutputDraft {
  return {
    jewelleryType,
    description: "",
    quantity: "1",
    grossWeight: "",
    netMetalWeight: "",
    metalType: defaultMetalType,
    purityId: defaultPurityId,
    diamondIds: [],
    photoAssetId: null,
    qcStatus: "PASSED",
    notes: "",
  };
}

type MetalReturnScrapLineDraft = { purityId: string; grossWeight: string };
function emptyReturnScrapLine(defaultPurityId: string): MetalReturnScrapLineDraft {
  return { purityId: defaultPurityId, grossWeight: "" };
}

/** Weight entered by the user → thousandths; blank counts as zero, anything unparseable or negative → null. */
function parseWeight(value: string): bigint | null {
  if (value.trim() === "") return ZERO;
  try {
    const parsed = toThousandths(value);
    return parsed < ZERO ? null : parsed;
  } catch {
    return null;
  }
}

const g = formatThousandths;

function rupees(value: string): string {
  return Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type ChargesEchoView = { labour: string; making: string; setting: string; plating: string; other: string; total: string };
type PostingView = {
  materials: string;
  charges: string;
  customerGoldCost: string;
  customerGoldFine: string;
  totalCompanyCost: string;
  lines: { accountCode: string; accountName: string; debit: string; credit: string; party: string | null }[];
  balanced: boolean;
};

const money2 = (v: string) => (Number(v) || 0).toFixed(2);

/** "Making ₹41886.00 · …" for every non-zero charge, and the total. */
function chargeSummary(c: ChargesEchoView): string {
  const parts = (
    [
      ["Labour", c.labour],
      ["Making", c.making],
      ["Setting", c.setting],
      ["Plating", c.plating],
      ["Other expense", c.other],
    ] as const
  ).filter(([, v]) => Number(v) !== 0);
  return `${parts.length ? parts.map(([k, v]) => `${k} ₹${money2(v)}`).join(" · ") : "no charges"} · Total charges ₹${money2(c.total)}`;
}

/** What the server received as charges, and (Owner only) the exact posting Save would make. */
function ChargesAndPosting({ charges, posting }: { charges: ChargesEchoView; posting: PostingView | null }) {
  return (
    <div className="mt-2 flex flex-col gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-xs" data-testid="receipt-charges-posting">
      <p>
        <span className="font-semibold">Charges:</span> {Number(charges.total) === 0 && !posting ? "none entered" : chargeSummary(charges)}
      </p>
      {posting ? (
        <>
          <p>
            Materials ₹{posting.materials} · Customer-owned Gold ₹{posting.customerGoldCost}
            {Number(posting.customerGoldFine) > 0 ? ` (${posting.customerGoldFine} g fine)` : ""} · Charges in the pieces ₹{posting.charges} ·{" "}
            <strong>Expected total Company cost ₹{posting.totalCompanyCost}</strong>
          </p>
          <p>
            <span className="font-semibold">Expected entry:</span>{" "}
            {posting.lines.length === 0
              ? "no voucher (nothing for the Company to post)"
              : posting.lines
                  .map((l) =>
                    Number(l.debit) > 0 ? `Dr ${l.accountCode} ${l.accountName} ₹${l.debit}` : `Cr ${l.accountCode} ${l.accountName}${l.party ? ` (${l.party})` : ""} ₹${l.credit}`
                  )
                  .join(" / ")}
            {posting.lines.length ? (posting.balanced ? " — balanced" : " — NOT BALANCED") : ""}
          </p>
        </>
      ) : null}
    </div>
  );
}

/** One label/value pair of the Karigar Metal preview list. */
function FragmentRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

export function ReceiveFinishedForm({
  jobId,
  jobCode,
  jewelleryType,
  pendingFineWeight,
  purities,
  issuedMetal,
  alloyPendingGrossWeight,
  unresolvedDiamonds,
  pendingPackets = [],
  custodySources = [],
  customerGoldSources = [],
  customerName = null,
  isOwner,
  onDone,
}: {
  jobId: string;
  jobCode: string;
  jewelleryType: string;
  pendingFineWeight: string;
  /** Active Metal/Purity master — the candidate Final Purity list for a single-source job. */
  purities: MetalPurityOption[];
  /** What this job actually issued, per purity. Return/scrap lines may only name one of these. */
  issuedMetal: IssuedMetalOption[];
  alloyPendingGrossWeight: string;
  unresolvedDiamonds: UnresolvedDiamondOption[];
  pendingPackets?: PendingPacketOption[];
  /** The job's Karigar's compatible unallocated Karigar Metal pools (weights only; Owner and Staff). */
  custodySources?: CustodySourceOption[];
  /** The job's Customer's own gold this job can be received from (weights only; Owner and Staff). */
  customerGoldSources?: CustomerGoldSourceOption[];
  customerName?: string | null;
  isOwner: boolean;
  onDone?: () => void;
}) {
  const [state, formAction, pending] = useActionState(receiveFinishedJewelleryAction, undefined);
  const [previewState, previewAction, previewPending] = useActionState<CustodyPreviewState, FormData>(previewReceiptCustodyAction, undefined);
  const [previewedSignature, setPreviewedSignature] = useState<string | null>(null);
  const issuedFineBearing = useMemo(() => issuedMetal.filter((m) => !m.isAlloy), [issuedMetal]);
  const custodyOptions = custodySources;
  // Customer-owned gold: the default whenever the job already holds some, or
  // when the job holds no Company metal (a Customer's job whose gold is theirs);
  // "Company gold" stays one choice away.
  const [customerKey, setCustomerKey] = useState(() => {
    const onJob = customerGoldSources.find((s) => toThousandths(s.onJobFine) > ZERO);
    if (onJob) return customerKeyOf(onJob);
    return issuedFineBearing.length === 0 && customerGoldSources[0] ? customerKeyOf(customerGoldSources[0]) : "";
  });
  const customerSource = customerGoldSources.find((s) => customerKeyOf(s) === customerKey) ?? null;
  const customerMode = customerSource !== null;
  const mixedJob = customerMode && issuedFineBearing.length > 0;
  const [customerReturn, setCustomerReturn] = useState("");
  const [customerScrap, setCustomerScrap] = useState("");
  const [customerLoss, setCustomerLoss] = useState("");
  const [customerLossReason, setCustomerLossReason] = useState("");
  const [customerShare, setCustomerShare] = useState("");
  const [cgPreviewState, cgPreviewAction, cgPreviewPending] = useActionState<CustomerGoldPreviewState, FormData>(previewCustomerGoldReceiptAction, undefined);
  const [cgPreviewedSignature, setCgPreviewedSignature] = useState<string | null>(null);
  // Default to the Karigar's balance whenever there is one: metal already on
  // the job is used first, and only the shortfall is taken from the balance.
  const [custodySourceId, setCustodySourceId] = useState(custodyOptions[0]?.purityId ?? "");
  const custodySource = customerMode ? null : (custodyOptions.find((s) => s.purityId === custodySourceId) ?? null);
  const custodyMode = custodySource !== null;
  const fineBearing = useMemo(
    () =>
      withCustodySource(
        issuedFineBearing,
        customerSource
          ? { purityId: customerSource.purityId, metalType: customerSource.metalType, displayName: customerSource.displayName, finenessPercent: customerSource.finenessPercent, unallocatedGross: "0.000", unallocatedFine: "0.000" }
          : custodySource
      ),
    [issuedFineBearing, customerSource, custodySource]
  );
  // Company return / scrap lines only ever name the job's Company metal.
  const companyReturnPurities = customerMode ? issuedFineBearing : fineBearing;
  // No metal on the job and no Karigar Metal to take it from.
  const noMetalSource = fineBearing.length === 0;
  const metalTypeChoices = noMetalSource
    ? [...new Set(purities.filter((p) => p.metalType !== "ALLOY").map((p) => p.metalType))]
    : [...new Set(fineBearing.map((p) => p.metalType))];
  const [receiveDate, setReceiveDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [explicitLoss, setExplicitLoss] = useState("0");
  const companyAlloy = useMemo(() => issuedMetal.find((m) => m.isAlloy) ?? null, [issuedMetal]);
  const defaultMetalType = fineBearing[0]?.metalType ?? "GOLD";
  const defaultIssuedPurityId = fineBearing[0]?.purityId ?? "";
  const [outputs, setOutputs] = useState<OutputDraft[]>([emptyOutput(defaultMetalType, defaultIssuedPurityId, jewelleryType)]);
  const [returnedLines, setReturnedLines] = useState<MetalReturnScrapLineDraft[]>([emptyReturnScrapLine(defaultIssuedPurityId)]);
  const [scrapLines, setScrapLines] = useState<MetalReturnScrapLineDraft[]>([emptyReturnScrapLine(defaultIssuedPurityId)]);
  const [returnedAlloy, setReturnedAlloy] = useState("");
  const [diamondResolutions, setDiamondResolutions] = useState<Record<string, "RETURNED" | "DAMAGED_LOST">>({});
  const [damagedLostReasons, setDamagedLostReasons] = useState<Record<string, string>>({});
  const [packetDrafts, setPacketDrafts] = useState<Record<string, PacketResolutionDraft>>({});
  const [karigarAddedFineWeight, setKarigarAddedFineWeight] = useState("0");
  const [karigarAddedCost, setKarigarAddedCost] = useState("0");
  const [alloyTouched, setAlloyTouched] = useState(false);
  const [companyAlloyInput, setCompanyAlloyInput] = useState("0");
  const [karigarAlloyInput, setKarigarAlloyInput] = useState("0");
  const [karigarAlloyCost, setKarigarAlloyCost] = useState("0");
  const [includedAlloyInput, setIncludedAlloyInput] = useState("0");
  const [labourCharge, setLabourCharge] = useState("0");
  const [makingCharge, setMakingCharge] = useState("0");
  const [settingCharge, setSettingCharge] = useState("0");
  const [platingCharge, setPlatingCharge] = useState("0");
  const [otherExpense, setOtherExpense] = useState("0");
  const [markJobComplete, setMarkJobComplete] = useState(false);
  const [isAbnormalLoss, setIsAbnormalLoss] = useState(false);
  const [abnormalLossReason, setAbnormalLossReason] = useState("");
  const [showMore, setShowMore] = useState(false);
  const [notes, setNotes] = useState("");
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.success) onDone?.();
  }, [state?.success, onDone]);

  /** Final Purity choices for an output of `metalType` — mirrors the server rule in receiveFinishedJewellery. */
  function finalPurityOptions(metalType: string): FinalPurityOption[] {
    const sources = fineBearing.filter((m) => m.metalType === metalType);
    const issued = sources.map((s) => ({ id: s.purityId, displayName: s.displayName, finenessPercent: s.finenessPercent, isIssued: true }));
    if (noMetalSource) {
      // Nothing to receive against yet: still list the purities (never an
      // empty list); the block reason below says why it cannot be saved.
      return purities
        .filter((p) => p.metalType === metalType && toThousandths(p.finenessPercent) > ZERO)
        .sort((a, b) => Number(toThousandths(b.finenessPercent) - toThousandths(a.finenessPercent)))
        .map((p) => ({ id: p.id, displayName: p.displayName, finenessPercent: p.finenessPercent, isIssued: false }));
    }
    if (sources.length !== 1) return issued;
    const sourceFineness = toThousandths(sources[0].finenessPercent);
    const lower = purities
      .filter((p) => p.metalType === metalType && p.id !== sources[0].purityId)
      .filter((p) => {
        const fineness = toThousandths(p.finenessPercent);
        return fineness > ZERO && fineness <= sourceFineness;
      })
      .sort((a, b) => Number(toThousandths(b.finenessPercent) - toThousandths(a.finenessPercent)))
      .map((p) => ({ id: p.id, displayName: p.displayName, finenessPercent: p.finenessPercent, isIssued: false }));
    return [...issued, ...lower];
  }

  function outputMetal(output: OutputDraft): { fine: bigint; alloy: bigint; valid: boolean } {
    const net = parseWeight(output.netMetalWeight);
    if (net === null) return { fine: ZERO, alloy: ZERO, valid: false };
    if (net === ZERO) return { fine: ZERO, alloy: ZERO, valid: true };
    const sources = fineBearing.filter((m) => m.metalType === output.metalType);
    const samePuritySource = sources.find((s) => s.purityId === output.purityId);
    const source = samePuritySource ?? (sources.length === 1 ? sources[0] : undefined);
    const option = finalPurityOptions(output.metalType).find((p) => p.id === output.purityId);
    if (!source || !option) return { fine: ZERO, alloy: ZERO, valid: false };
    const metal = computeOutputMetal({
      netWeight: output.netMetalWeight,
      outputFinenessPercent: option.finenessPercent,
      sourceFinenessPercent: source.finenessPercent,
      samePurity: Boolean(samePuritySource),
    });
    return { fine: metal.fine, alloy: metal.alloyAdded, valid: metal.alloyAdded >= ZERO };
  }

  function lineFine(line: MetalReturnScrapLineDraft): bigint | null {
    const gross = parseWeight(line.grossWeight);
    if (gross === null) return null;
    const purity = fineBearing.find((m) => m.purityId === line.purityId);
    if (!purity) return ZERO;
    return fineWeightThousandths(gross, toThousandths(purity.finenessPercent));
  }

  function updateOutput(index: number, patch: Partial<OutputDraft>) {
    setOutputs((prev) => prev.map((o, i) => (i === index ? { ...o, ...patch } : o)));
  }
  function addOutput() {
    setOutputs((prev) => [...prev, emptyOutput(defaultMetalType, defaultIssuedPurityId, jewelleryType)]);
  }
  function removeOutput(index: number) {
    setOutputs((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  function updateReturnedLine(index: number, patch: Partial<MetalReturnScrapLineDraft>) {
    setReturnedLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }
  function addReturnedLine() {
    setReturnedLines((prev) => [...prev, emptyReturnScrapLine(defaultIssuedPurityId)]);
  }
  function removeReturnedLine(index: number) {
    setReturnedLines((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  }
  function updateScrapLine(index: number, patch: Partial<MetalReturnScrapLineDraft>) {
    setScrapLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }
  function addScrapLine() {
    setScrapLines((prev) => [...prev, emptyReturnScrapLine(defaultIssuedPurityId)]);
  }
  function removeScrapLine(index: number) {
    setScrapLines((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  /** Switching the Customer gold source (or leaving it) re-points outputs to a valid purity. */
  function chooseCustomerSource(key: string) {
    setCustomerKey(key);
    const src = customerGoldSources.find((s) => customerKeyOf(s) === key) ?? null;
    if (src) {
      const next = withCustodySource(issuedFineBearing, { purityId: src.purityId, metalType: src.metalType, displayName: src.displayName, finenessPercent: src.finenessPercent, unallocatedGross: "0.000", unallocatedFine: "0.000" });
      const valid = new Set(next.map((m) => m.purityId));
      setOutputs((prev) =>
        prev.map((o) =>
          o.metalType === src.metalType && (valid.has(o.purityId) || purities.some((p) => p.id === o.purityId && p.metalType === o.metalType))
            ? o
            : { ...o, metalType: src.metalType, purityId: src.purityId }
        )
      );
    } else {
      chooseCustodySource(custodySourceId);
    }
  }

  /** Switching the Karigar Metal pool re-points any output/return/scrap line that no longer has a valid purity. */
  function chooseCustodySource(purityId: string) {
    setCustodySourceId(purityId);
    const next = withCustodySource(issuedFineBearing, custodyOptions.find((s) => s.purityId === purityId) ?? null);
    const first = next[0];
    const valid = new Set(next.map((m) => m.purityId));
    setOutputs((prev) =>
      prev.map((o) => {
        if (next.some((m) => m.metalType === o.metalType) && (valid.has(o.purityId) || purities.some((p) => p.id === o.purityId && p.metalType === o.metalType)))
          return o;
        return { ...o, metalType: first?.metalType ?? o.metalType, purityId: first?.purityId ?? "" };
      })
    );
    const fixLine = (l: MetalReturnScrapLineDraft) => (valid.has(l.purityId) ? l : { ...l, purityId: first?.purityId ?? "" });
    setReturnedLines((prev) => prev.map(fixLine));
    setScrapLines((prev) => prev.map(fixLine));
  }

  const assignedDiamondIds = useMemo(() => new Set(outputs.flatMap((o) => o.diamondIds)), [outputs]);
  const remainingDiamonds = unresolvedDiamonds.filter((d) => !assignedDiamondIds.has(d.polishedDiamondId));

  function toggleDiamondForOutput(outputIndex: number, polishedDiamondId: string) {
    setDiamondResolutions((prev) => {
      const next = { ...prev };
      delete next[polishedDiamondId];
      return next;
    });
    setOutputs((prev) =>
      prev.map((o, i) => {
        if (i !== outputIndex) {
          return { ...o, diamondIds: o.diamondIds.filter((id) => id !== polishedDiamondId) };
        }
        const has = o.diamondIds.includes(polishedDiamondId);
        return { ...o, diamondIds: has ? o.diamondIds.filter((id) => id !== polishedDiamondId) : [...o.diamondIds, polishedDiamondId] };
      })
    );
  }

  function setRemainingResolution(polishedDiamondId: string, resolution: "RETURNED" | "DAMAGED_LOST" | null) {
    setDiamondResolutions((prev) => {
      const next = { ...prev };
      if (resolution === null) delete next[polishedDiamondId];
      else next[polishedDiamondId] = resolution;
      return next;
    });
  }

  // ---- Reconciliation (exact thousandths — the same math the server enforces) ----
  const outputMetals = outputs.map(outputMetal);
  const outputsFine = outputMetals.reduce((sum, m) => sum + m.fine, ZERO);
  const expectedAlloy = outputMetals.reduce((sum, m) => sum + m.alloy, ZERO);
  const invalidOutput = outputMetals.some((m) => !m.valid);
  const returnedFines = returnedLines.map(lineFine);
  const scrapFines = scrapLines.map(lineFine);
  const invalidReturnOrScrap = [...returnedFines, ...scrapFines].some((v) => v === null);
  const returnedFine = returnedFines.reduce<bigint>((sum, v) => sum + (v ?? ZERO), ZERO);
  const scrapFine = scrapFines.reduce<bigint>((sum, v) => sum + (v ?? ZERO), ZERO);
  const karigarAdded = parseWeight(karigarAddedFineWeight) ?? ZERO;
  const jobAvailable = toThousandths(pendingFineWeight) + karigarAdded;
  const custodyFine = custodySource ? toThousandths(custodySource.unallocatedFine) : ZERO;
  // With a Karigar Metal pool chosen, the job's own metal is used first and
  // only the shortfall comes from the balance; the rest of the balance stays
  // with the Karigar and is never written off by this receipt.
  const pendingAvailable = jobAvailable + custodyFine;
  const resolvedThisReceipt = outputsFine + returnedFine + scrapFine;
  // Customer gold: the server plan (preview) is the authority on balances.
  const exceedsAvailable = !customerMode && resolvedThisReceipt > pendingAvailable;
  const gap = pendingAvailable - resolvedThisReceipt;
  const jobGap = jobAvailable - resolvedThisReceipt;
  const explicitLossWeight = custodyMode && markJobComplete ? parseWeight(explicitLoss) : ZERO;
  const willCompleteMetal = custodyMode || customerMode ? markJobComplete : gap === ZERO || markJobComplete;
  const previewLoss = customerMode ? ZERO : custodyMode ? (explicitLossWeight ?? ZERO) : willCompleteMetal && gap > ZERO ? gap : ZERO;
  const allDiamondsResolvedThisReceipt = remainingDiamonds.every((d) => diamondResolutions[d.polishedDiamondId]);
  // ---- Packet stones: every entry is explicit; anything not entered stays
  // pending with the Karigar (never assumed lost). ----
  const packetResolutionsForSubmit = pendingPackets.flatMap((p) => {
    const d = packetDrafts[p.packetId];
    if (!d) return [];
    const rows: { packetId: string; resolution: "SET" | "RETURNED" | "DAMAGED_LOST"; pieces: string; carat: string; setInOutputIndex?: string; damagedLostReason?: string }[] = [];
    if (Number(d.set.pieces) > 0 || Number(d.set.carat) > 0) {
      // Blank output drafts are dropped before submit, so translate the
      // chosen draft into its position among the outputs actually sent.
      const draftIndex = Math.min(Number(d.setOutputIndex) || 0, outputs.length - 1);
      const submittedIndex = outputs.slice(0, draftIndex).filter((o) => Number(o.netMetalWeight) > 0).length;
      rows.push({ packetId: p.packetId, resolution: "SET", pieces: d.set.pieces || "0", carat: d.set.carat || "0", setInOutputIndex: String(submittedIndex) });
    }
    if (Number(d.returned.pieces) > 0 || Number(d.returned.carat) > 0) {
      rows.push({ packetId: p.packetId, resolution: "RETURNED", pieces: d.returned.pieces || "0", carat: d.returned.carat || "0" });
    }
    if (isOwner && (Number(d.damaged.pieces) > 0 || Number(d.damaged.carat) > 0)) {
      rows.push({ packetId: p.packetId, resolution: "DAMAGED_LOST", pieces: d.damaged.pieces || "0", carat: d.damaged.carat || "0", damagedLostReason: d.reason });
    }
    return rows;
  });
  const packetStatus = pendingPackets.map((p) => {
    const mine = packetResolutionsForSubmit.filter((r) => r.packetId === p.packetId);
    const pieces = mine.reduce((sum, r) => sum + (Number(r.pieces) || 0), 0);
    const carat = mine.reduce((sum, r) => sum + ct1000(r.carat), 0);
    const pendingCarat = ct1000(p.pendingCarat);
    let problem: string | null = null;
    if (pieces > p.pendingPieces || carat > pendingCarat) problem = `${p.packetCode}: more than the ${p.pendingPieces} pcs / ${p.pendingCarat}ct still pending.`;
    else if (mine.length > 0 && (pieces === p.pendingPieces) !== (carat === pendingCarat)) problem = `${p.packetCode}: pieces and carat must be fully resolved together.`;
    else if (
      mine.some((r) => r.resolution === "SET") &&
      !(Number(outputs[Math.min(Number(packetDrafts[p.packetId]?.setOutputIndex) || 0, outputs.length - 1)]?.netMetalWeight) > 0)
    )
      problem = `${p.packetCode}: set stones must go into a finished output that has a net weight.`;
    else if (mine.some((r) => r.resolution === "DAMAGED_LOST" && (r.damagedLostReason ?? "").trim().length < 3)) problem = `Give a reason for marking stones from ${p.packetCode} damaged/lost.`;
    return { packet: p, fullyResolved: pieces === p.pendingPieces && carat === pendingCarat, problem };
  });
  const packetProblem = packetStatus.find((s) => s.problem)?.problem ?? null;
  const allPacketsResolvedThisReceipt = packetStatus.every((s) => s.fullyResolved);
  function updatePacketDraft(packetId: string, patch: Partial<PacketResolutionDraft>) {
    setPacketDrafts((prev) => ({ ...prev, [packetId]: { ...(prev[packetId] ?? emptyPacketDraft()), ...patch } }));
  }

  const willCompleteJob = willCompleteMetal && allDiamondsResolvedThisReceipt && allPacketsResolvedThisReceipt;

  // ---- Alloy Added source split ----
  const alloyPending = toThousandths(alloyPendingGrossWeight);
  const returnedAlloyWeight = parseWeight(returnedAlloy);
  const defaultCompany = companyAlloy && alloyPending >= expectedAlloy ? expectedAlloy : ZERO;
  const defaultIncluded = expectedAlloy - defaultCompany;
  const companySplit = alloyTouched ? parseWeight(companyAlloyInput) : defaultCompany;
  const karigarSplit = alloyTouched ? parseWeight(karigarAlloyInput) : ZERO;
  const includedSplit = alloyTouched ? parseWeight(includedAlloyInput) : defaultIncluded;
  const splitValid = companySplit !== null && karigarSplit !== null && includedSplit !== null;
  const enteredAlloy = splitValid ? companySplit + karigarSplit + includedSplit : null;
  const alloyMismatch = enteredAlloy === null || enteredAlloy !== expectedAlloy;
  const companyOverUse =
    companySplit !== null && returnedAlloyWeight !== null && companySplit + returnedAlloyWeight > (companyAlloy ? alloyPending : ZERO);
  const karigarAlloyCostValue = Number(karigarAlloyCost) || 0;
  const orphanKarigarCost = karigarAlloyCostValue > 0 && (karigarSplit === null || karigarSplit === ZERO);

  function editAlloy(field: "company" | "karigar" | "included", value: string) {
    if (!alloyTouched) {
      setCompanyAlloyInput(g(defaultCompany));
      setKarigarAlloyInput("0.000");
      setIncludedAlloyInput(g(defaultIncluded));
      setAlloyTouched(true);
    }
    if (field === "company") setCompanyAlloyInput(value);
    if (field === "karigar") setKarigarAlloyInput(value);
    if (field === "included") setIncludedAlloyInput(value);
  }

  const blockReason = noMetalSource && outputs.some((o) => Number(o.netMetalWeight) > 0)
    ? "This job holds no metal and its Karigar has no unallocated Karigar Metal to receive it from. Ask the Owner to issue the metal to this Karigar in Karigar Metal first."
    : invalidOutput
    ? "Check each output: enter a valid net metal weight and a Final Purity no finer than the issued metal."
    : invalidReturnOrScrap || returnedAlloyWeight === null
      ? "Check the returned and scrap weights."
      : exceedsAvailable
        ? custodyMode
          ? `Finished plus returned plus scrap needs ${g(resolvedThisReceipt)}g fine — more than this job's ${g(jobAvailable)}g plus the Karigar's unallocated ${g(custodyFine)}g fine.`
          : "Finished plus returned plus scrap fine weight cannot exceed the fine weight still pending for this job." +
            (custodyOptions.length > 0 ? " Choose the Karigar's balance above to take the shortfall from it." : "")
        : explicitLossWeight === null
          ? "Check the process loss weight."
          : custodyMode && markJobComplete && explicitLossWeight < jobGap
            ? `Completing leaves ${g(jobGap)}g fine on this job: record it as process loss (at least ${g(jobGap)}g), or return/scrap it, or leave the job open.`
            : alloyMismatch
          ? `Alloy Added is ${g(expectedAlloy)}g — the Company / Karigar / Included split must total exactly ${g(expectedAlloy)}g.`
          : companyOverUse
            ? `Company alloy used plus returned alloy cannot exceed the ${alloyPendingGrossWeight}g of Copper/Alloy still with the Karigar.`
            : orphanKarigarCost
              ? "A Karigar alloy charge needs a Karigar-added alloy weight."
              : null;

  const isGoldJob = fineBearing.length > 0 && fineBearing.every((m) => m.metalType === "GOLD");
  const fineLabel = isGoldJob ? "Fine Gold Weight" : "Fine metal weight";

  function submitReceipt(event: React.FormEvent<HTMLFormElement>) {
    // Dispatched by hand (not through <form action>) so React never resets the
    // form after a refused save: controlled selects would otherwise show a
    // choice that no longer matches what is submitted.
    event.preventDefault();
    if (!confirmReceipt()) return;
    const formData = new FormData(event.currentTarget);
    // Every posting field comes from the form STATE, whatever the UI shows:
    // a collapsed charges section can never drop or reset a charge.
    for (const [name, value] of postingFields) formData.set(name, value);
    startTransition(() => formAction(formData));
  }

  function confirmReceipt(): boolean {
    const problem =
      blockReason ??
      packetProblem ??
      remainingDiamonds
        .filter((d) => diamondResolutions[d.polishedDiamondId] === "DAMAGED_LOST" && (damagedLostReasons[d.polishedDiamondId] ?? "").trim().length < 3)
        .map((d) => `Give a reason for marking diamond ${d.polishedCode} damaged/lost.`)[0] ??
      (isAbnormalLoss && abnormalLossReason.trim().length < 3 ? "Give a reason for classifying this loss as abnormal." : null) ??
      custodyBlock ??
      customerBlock;
    if (problem) {
      window.alert(problem);
      return false;
    }
    const chargesLine = `\nCharges: ${chargeSummary(enteredCharges)}`;
    if (customerMode && freshCustomerPreview) {
      const p = freshCustomerPreview;
      const totalLine = p.posting ? `\nExpected total Company cost ₹${p.posting.totalCompanyCost}` : "";
      return window.confirm(
        `${p.customerName}'s own gold (${p.sourceLabel}, ${p.sourceFineness}%) — Customer-owned, excluded from Company material cost.` +
          `\nFinished pieces: ${p.customerFineForOutputs}g fine of the Customer's gold${p.mixed ? ` + ${p.companyFineForOutputs}g fine Company gold` : ""}.` +
          `\nReturned ${p.returned.fine}g · Scrap ${p.scrap.fine}g · Authorised loss ${p.lossFine}g fine.` +
          `\nTaken now: ${p.fromKarigar.fine}g fine from ${p.karigarName}, ${p.fromSafe.fine}g fine from the safe.` +
          `\nLeft on this job: ${p.onJobAfter.fine}g fine.${p.completesJob ? " This completes the job's gold." : ""}` +
          chargesLine +
          totalLine +
          "\n\nSave this receipt?"
      );
    }
    const summary = willCompleteJob
      ? `This will COMPLETE job ${jobCode}. Process Loss: ${g(previewLoss)}g fine.`
      : willCompleteMetal
        ? `Metal is fully resolved but some diamonds or packet stones remain with the Karigar — job ${jobCode} will stay Partially Received.`
        : custodyMode
          ? `Partial receipt for job ${jobCode}. ${freshPreview?.jobPendingAfterReceipt ?? "0.000"}g fine stays on this job.`
          : `Partial receipt for job ${jobCode}. ${g(gap > ZERO ? gap : ZERO)}g fine metal remains with the Karigar.`;
    const custodyLine = freshPreview
      ? freshPreview.allocation
        ? `\nFrom ${freshPreview.karigarName}'s ${freshPreview.sourceLabel} balance: ${freshPreview.allocation.fineWeight}g fine (${freshPreview.allocation.grossWeight}g gross). ${freshPreview.custodyAfter.fine}g fine stays in the balance.`
        : `\nNothing is taken from ${freshPreview.karigarName}'s balance; this job's own metal covers it.`
      : "";
    const alloyLine = expectedAlloy > ZERO ? `\nAlloy Added: ${g(expectedAlloy)}g.` : "";
    const custodyTotalLine = freshPreview?.posting ? `\nExpected total Company cost ₹${freshPreview.posting.totalCompanyCost}` : "";
    return window.confirm(`${summary}${custodyLine}${alloyLine}${chargesLine}${custodyTotalLine}\n\nSave this receipt?`);
  }

  const outputsForSubmit = outputs
    .filter((o) => Number(o.netMetalWeight) > 0)
    .map((o) => ({
      jewelleryType: o.jewelleryType,
      description: o.description || undefined,
      quantity: o.quantity || "1",
      grossWeight: o.grossWeight || undefined,
      netMetalWeight: o.netMetalWeight,
      metalType: o.metalType,
      purityId: o.purityId,
      diamondIds: o.diamondIds,
      photoAssetId: o.photoAssetId || undefined,
      qcStatus: o.qcStatus,
      notes: o.notes || undefined,
    }));

  const companyPurityIds = new Set(companyReturnPurities.map((p) => p.purityId));
  const returnedLinesForSubmit = [
    ...returnedLines
      .filter((l) => l.purityId && companyPurityIds.has(l.purityId) && Number(l.grossWeight) > 0)
      .map((l) => ({ purityId: l.purityId, grossWeight: l.grossWeight })),
    ...(companyAlloy && returnedAlloyWeight !== null && returnedAlloyWeight > ZERO
      ? [{ purityId: companyAlloy.purityId, grossWeight: g(returnedAlloyWeight) }]
      : []),
  ];
  const scrapLinesForSubmit = scrapLines
    .filter((l) => l.purityId && companyPurityIds.has(l.purityId) && Number(l.grossWeight) > 0)
    .map((l) => ({ purityId: l.purityId, grossWeight: l.grossWeight }));

  const setResolutions = outputs.flatMap((o) => o.diamondIds.map((id) => ({ polishedDiamondId: id, resolution: "SET" as const })));
  const remainingResolutionsForSubmit = Object.entries(diamondResolutions).map(([polishedDiamondId, resolution]) => ({
    polishedDiamondId,
    resolution,
    damagedLostReason: resolution === "DAMAGED_LOST" ? damagedLostReasons[polishedDiamondId] || undefined : undefined,
  }));
  const diamondResolutionsForSubmit = [...setResolutions, ...remainingResolutionsForSubmit];

  // ---- Everything the posting depends on beyond the metal plan, from STATE:
  // sent to every Preview, part of every stale-check, and set on the saved form. ----
  const enteredCharges: ChargesEchoView = {
    labour: labourCharge,
    making: makingCharge,
    setting: settingCharge,
    plating: platingCharge,
    other: otherExpense,
    total: String([labourCharge, makingCharge, settingCharge, platingCharge, otherExpense].reduce((sum, v) => sum + (Number(v) || 0), 0)),
  };
  const postingFields: [string, string][] = [
    ["diamondResolutionsJson", JSON.stringify(diamondResolutionsForSubmit)],
    ["packetResolutionsJson", JSON.stringify(packetResolutionsForSubmit)],
    ["companyAlloyGrossWeight", companySplit !== null ? g(companySplit) : ""],
    ["karigarAlloyGrossWeight", karigarSplit !== null ? g(karigarSplit) : ""],
    ["includedAlloyGrossWeight", includedSplit !== null ? g(includedSplit) : ""],
    ["karigarAlloyCost", karigarAlloyCost || "0"],
    ["isAbnormalLoss", isAbnormalLoss ? "true" : "false"],
    ["abnormalLossReason", isAbnormalLoss ? abnormalLossReason : ""],
    ["labourCharge", labourCharge || "0"],
    ["makingCharge", makingCharge || "0"],
    ["settingCharge", settingCharge || "0"],
    ["platingCharge", platingCharge || "0"],
    ["otherExpense", otherExpense || "0"],
    ["karigarAddedFineWeight", karigarAddedFineWeight || "0"],
    ["karigarAddedCost", karigarAddedCost || "0"],
    ["notes", notes],
  ];

  // ---- Karigar Metal preview: everything the server plans from, so any edit
  // after previewing makes the preview stale and blocks the save. ----
  const explicitLossForSubmit = custodyMode && markJobComplete && explicitLossWeight !== null ? g(explicitLossWeight) : "";
  const custodyFields: [string, string][] = custodySource
    ? [
        ["jobId", jobId],
        ["receiveDate", receiveDate],
        ["outputsJson", JSON.stringify(outputsForSubmit)],
        ["returnedMetalLinesJson", JSON.stringify(returnedLinesForSubmit)],
        ["scrapMetalLinesJson", JSON.stringify(scrapLinesForSubmit)],
        ["karigarAddedFineWeight", karigarAddedFineWeight || "0"],
        ["markJobComplete", markJobComplete ? "true" : "false"],
        ["custodySourcePurityId", custodySource.purityId],
        ["explicitLossFineWeight", explicitLossForSubmit],
      ]
    : [];
  const custodySignature = custodyMode ? JSON.stringify([custodyFields, postingFields]) : null;
  const freshPreview =
    custodyMode && !previewPending && previewState?.preview && previewedSignature === custodySignature ? previewState.preview : null;
  const previewError = custodyMode && !previewPending && previewedSignature === custodySignature ? (previewState?.error ?? null) : null;
  const custodyBlock = custodyMode && !freshPreview ? "Preview the gold taken from the Karigar's balance, then save." : null;
  // What stays on the job after this receipt before any Karigar Metal is
  // taken: completing the job must record it as process loss.
  const leftOnJobWithoutAllocation = jobGap > ZERO ? jobGap : ZERO;

  // ---- Customer gold preview: same rule — any edit after it blocks the save. ----
  const customerFields: [string, string][] = customerSource
    ? [
        ["jobId", jobId],
        ["receiveDate", receiveDate],
        ["outputsJson", JSON.stringify(outputsForSubmit)],
        ["returnedMetalLinesJson", JSON.stringify(returnedLinesForSubmit)],
        ["scrapMetalLinesJson", JSON.stringify(scrapLinesForSubmit)],
        ["karigarAddedFineWeight", karigarAddedFineWeight || "0"],
        ["markJobComplete", markJobComplete ? "true" : "false"],
        ["customerGoldSourcePurityId", customerSource.purityId],
        ["customerGoldFineness", customerSource.finenessPercent],
        ["customerFineForOutputs", mixedJob ? customerShare : ""],
        ["customerReturnGross", customerReturn],
        ["customerScrapGross", customerScrap],
        ["customerLossFine", isOwner ? customerLoss : ""],
        ["customerLossReason", isOwner ? customerLossReason : ""],
      ]
    : [];
  const customerSignature = customerMode ? JSON.stringify([customerFields, postingFields]) : null;
  const freshCustomerPreview =
    customerMode && !cgPreviewPending && cgPreviewState?.preview && cgPreviewedSignature === customerSignature ? cgPreviewState.preview : null;
  const customerPreviewError = customerMode && !cgPreviewPending && cgPreviewedSignature === customerSignature ? (cgPreviewState?.error ?? null) : null;
  // A mixed Customer + Company receipt is an Owner decision (the Customer's share) — Staff never make it.
  const mixedStaffBlock = mixedJob && !isOwner ? "This job holds both Customer and Company gold. Only the Owner can record a mixed receipt and decide the Customer's share." : null;
  const customerBlock = mixedStaffBlock ?? (customerMode && !freshCustomerPreview ? "Preview the Customer's gold used by this receipt, then save." : null);

  function runCustomerPreview() {
    if (!customerSignature) return;
    if (blockReason) {
      window.alert(blockReason);
      return;
    }
    const formData = new FormData();
    for (const [name, value] of [...customerFields, ...postingFields]) formData.set(name, value);
    setCgPreviewedSignature(customerSignature);
    startTransition(() => cgPreviewAction(formData));
  }

  function runCustodyPreview() {
    if (!custodySignature) return;
    if (blockReason) {
      window.alert(blockReason);
      return;
    }
    const formData = new FormData();
    for (const [name, value] of [...custodyFields, ...postingFields]) formData.set(name, value);
    setPreviewedSignature(custodySignature);
    startTransition(() => previewAction(formData));
  }

  return (
    <form
      ref={formRef}
      onSubmit={submitReceipt}
      className="flex flex-col gap-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6"
      noValidate
    >
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="outputsJson" value={JSON.stringify(outputsForSubmit)} />
      <input type="hidden" name="diamondResolutionsJson" value={JSON.stringify(diamondResolutionsForSubmit)} />
      <input type="hidden" name="packetResolutionsJson" value={JSON.stringify(packetResolutionsForSubmit)} />
      <input type="hidden" name="returnedMetalLinesJson" value={JSON.stringify(returnedLinesForSubmit)} />
      <input type="hidden" name="scrapMetalLinesJson" value={JSON.stringify(scrapLinesForSubmit)} />
      <input type="hidden" name="markJobComplete" value={markJobComplete ? "true" : "false"} />
      <input type="hidden" name="isAbnormalLoss" value={isAbnormalLoss ? "true" : "false"} />
      <input type="hidden" name="companyAlloyGrossWeight" value={companySplit !== null ? g(companySplit) : ""} />
      <input type="hidden" name="karigarAlloyGrossWeight" value={karigarSplit !== null ? g(karigarSplit) : ""} />
      <input type="hidden" name="includedAlloyGrossWeight" value={includedSplit !== null ? g(includedSplit) : ""} />
      <input type="hidden" name="karigarAlloyCost" value={karigarAlloyCost || "0"} />
      {/* Always present, from state: collapsing the charges section never omits them. */}
      <input type="hidden" name="labourCharge" value={labourCharge || "0"} />
      <input type="hidden" name="makingCharge" value={makingCharge || "0"} />
      <input type="hidden" name="settingCharge" value={settingCharge || "0"} />
      <input type="hidden" name="platingCharge" value={platingCharge || "0"} />
      <input type="hidden" name="otherExpense" value={otherExpense || "0"} />
      <input type="hidden" name="karigarAddedFineWeight" value={karigarAddedFineWeight || "0"} />
      <input type="hidden" name="karigarAddedCost" value={karigarAddedCost || "0"} />
      <input type="hidden" name="notes" value={notes} />
      {customerSource ? (
        <>
          {customerFields.slice(7).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <input type="hidden" name="customerGoldFingerprint" value={freshCustomerPreview?.fingerprint ?? ""} />
        </>
      ) : null}
      {custodySource ? (
        <>
          <input type="hidden" name="custodySourcePurityId" value={custodySource.purityId} />
          <input type="hidden" name="custodyFingerprint" value={freshPreview?.fingerprint ?? ""} />
          <input type="hidden" name="explicitLossFineWeight" value={explicitLossForSubmit} />
        </>
      ) : null}

      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? <Alert tone="success">Receipt saved as {state.code}.</Alert> : null}

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm text-zinc-700 dark:text-zinc-300">
        {issuedFineBearing.map((m) => (
          <p key={m.purityId}>
            <span className="font-semibold">{m.displayName} Issued</span> · {m.grossWeight}g gross / {m.fineWeight}g fine
          </p>
        ))}
        {issuedFineBearing.length === 0 && !customerMode ? <p>No metal has been allocated to this job yet.</p> : null}
        {customerGoldSources.map((s) =>
          toThousandths(s.onJobFine) > ZERO ? (
            <p key={customerKeyOf(s)}>
              <span className="font-semibold">{customerName ?? "Customer"}&apos;s own {s.displayName}</span> on this job · {s.onJobFine}g fine (Customer-owned)
            </p>
          ) : null
        )}
        {companyAlloy ? (
          <p>
            <span className="font-semibold">Copper/Alloy issued</span> · {companyAlloy.grossWeight}g · {alloyPendingGrossWeight}g still with Karigar
          </p>
        ) : null}
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Pending with Karigar: <span className="font-semibold text-zinc-900 dark:text-zinc-50">{pendingFineWeight}g fine metal</span>
        </p>
      </div>

      <Field label="Receive date" name="receiveDate" type="date" value={receiveDate} onChange={(e) => setReceiveDate(e.target.value)} required />

      {customerGoldSources.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-950 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-100" data-testid="customer-gold-source">
          <label className="flex flex-col gap-1.5">
            <span className="font-medium">Gold source</span>
            <select
              aria-label="Customer gold source"
              value={customerKey}
              onChange={(e) => chooseCustomerSource(e.target.value)}
              className="h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm text-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
            >
              {customerGoldSources.map((s) => (
                <option key={customerKeyOf(s)} value={customerKeyOf(s)}>
                  Customer-owned: {customerName ?? "Customer"}&apos;s {s.displayName} ({s.finenessPercent}%) · on job {s.onJobFine}g · with Karigar {s.withKarigarFine}g · safe {s.safeFine}g fine
                </option>
              ))}
              <option value="">Company gold (not the Customer&apos;s)</option>
            </select>
          </label>
          <p className="text-xs">
            Customer-owned gold is never Company stock or cost. The Customer&apos;s gold already on this job is used first; only the shortfall comes from the same
            Customer&apos;s gold with this Karigar, then in the safe. What remains stays the Customer&apos;s.
          </p>
        </div>
      ) : null}

      {!customerMode && custodyOptions.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100" data-testid="custody-source">
          <label className="flex flex-col gap-1.5">
            <span className="font-medium">Gold from the Karigar&apos;s balance (Karigar Metal)</span>
            <select
              aria-label="Karigar Metal source"
              value={custodySourceId}
              onChange={(e) => chooseCustodySource(e.target.value)}
              className="h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm text-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
            >
              {custodyOptions.map((s) => (
                <option key={s.purityId} value={s.purityId}>
                  {metalTypeLabel(s.metalType)} {s.displayName} ({s.finenessPercent}%) · {s.unallocatedFine}g fine / {s.unallocatedGross}g gross unallocated
                </option>
              ))}
              {issuedFineBearing.length > 0 ? <option value="">Don&apos;t use it: only the metal already on this job</option> : null}
            </select>
          </label>
          <p className="text-xs">
            This is the metal the Karigar was given. The finished jewellery&apos;s purity is chosen separately on each output below. Metal already on
            this job is used first; only the shortfall is taken from this balance, and the rest stays with the Karigar.
          </p>
        </div>
      ) : null}

      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          Finished jewellery outputs ({g(outputsFine)}g fine metal)
        </h3>
        {outputs.map((output, index) => {
          const purityOptions = finalPurityOptions(output.metalType);
          const metal = outputMetals[index];
          return (
            <div key={index} className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                <select
                  aria-label="Jewellery type"
                  value={output.jewelleryType}
                  onChange={(e) => updateOutput(index, { jewelleryType: e.target.value })}
                  className="h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                >
                  {JEWELLERY_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Description"
                  placeholder="Description (optional)"
                  value={output.description}
                  onChange={(e) => updateOutput(index, { description: e.target.value })}
                  className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                />
                <input
                  aria-label="Quantity"
                  type="number"
                  min="1"
                  placeholder="Qty"
                  value={output.quantity}
                  onChange={(e) => updateOutput(index, { quantity: e.target.value })}
                  className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                />
                <input
                  aria-label="Net metal weight"
                  type="number"
                  step="0.001"
                  min="0"
                  placeholder="Net metal weight (g)"
                  value={output.netMetalWeight}
                  onChange={(e) => updateOutput(index, { netMetalWeight: e.target.value })}
                  className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                />
              </div>
              <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-4">
                <select
                  aria-label="Metal type"
                  value={output.metalType}
                  onChange={(e) => {
                    const nextPurity = fineBearing.find((p) => p.metalType === e.target.value)?.purityId ?? finalPurityOptions(e.target.value)[0]?.id ?? "";
                    updateOutput(index, { metalType: e.target.value, purityId: nextPurity });
                  }}
                  className="h-9 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                >
                  {metalTypeChoices.map((mt) => (
                    <option key={mt} value={mt}>
                      {metalTypeLabel(mt)}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Final Purity"
                  value={output.purityId}
                  onChange={(e) => updateOutput(index, { purityId: e.target.value })}
                  className="h-9 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                >
                  {output.purityId === "" ? <option value="">Final Purity: choose…</option> : null}
                  {purityOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      Final Purity: {p.displayName}
                      {p.isIssued ? " (as issued)" : ""}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Gross Weight"
                  type="number"
                  step="0.001"
                  min="0"
                  placeholder="Gross Weight (optional, with stones)"
                  value={output.grossWeight}
                  onChange={(e) => updateOutput(index, { grossWeight: e.target.value })}
                  className="h-9 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                />
                <select
                  aria-label="QC status"
                  value={output.qcStatus}
                  onChange={(e) => updateOutput(index, { qcStatus: e.target.value as OutputDraft["qcStatus"] })}
                  className="h-9 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                >
                  <option value="PASSED">QC: Passed</option>
                  <option value="NEEDS_CORRECTION">QC: Needs Correction</option>
                  <option value="REJECTED">QC: Rejected</option>
                </select>
              </div>
              <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
                {fineLabel}: <span className="font-semibold">{g(metal.fine)}g</span>
                {metal.alloy > ZERO ? (
                  <>
                    {" "}
                    · Alloy Added: <span className="font-semibold">{g(metal.alloy)}g</span>
                  </>
                ) : null}
                {!metal.valid ? <span className="ml-2 font-medium text-red-600 dark:text-red-400">Check this output</span> : null}
              </p>

              {unresolvedDiamonds.length > 0 ? (
                <div className="mt-2">
                  <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Diamonds set in this piece</p>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {unresolvedDiamonds
                      .filter((d) => output.diamondIds.includes(d.polishedDiamondId) || remainingDiamonds.includes(d))
                      .map((d) => (
                        <label
                          key={d.polishedDiamondId}
                          className="flex items-center gap-1.5 rounded-full border border-[var(--border)] px-2.5 py-1 text-xs text-zinc-600 dark:text-zinc-400"
                        >
                          <input
                            type="checkbox"
                            checked={output.diamondIds.includes(d.polishedDiamondId)}
                            onChange={() => toggleDiamondForOutput(index, d.polishedDiamondId)}
                            className="h-3.5 w-3.5 rounded border-zinc-300"
                          />
                          {d.polishedCode} ({d.carat}ct)
                        </label>
                      ))}
                  </div>
                </div>
              ) : null}

              <div className="mt-2 flex flex-wrap items-center gap-3">
                <JewelleryPhotoUploadField
                  category="jewellery-finished"
                  label="Finished photo"
                  assetId={output.photoAssetId}
                  onUploaded={(assetId) => updateOutput(index, { photoAssetId: assetId })}
                />
                {outputs.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => removeOutput(index)}
                    className="ml-auto text-xs font-medium text-red-600 hover:underline dark:text-red-400"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
        <Button type="button" variant="secondary" size="md" onClick={addOutput} className="self-start">
          + Add another output
        </Button>
      </div>

      {expectedAlloy > ZERO || companyAlloy ? (
        <div className="flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3">
          <div>
            <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Alloy Added ({g(expectedAlloy)}g)</h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Net weight of the finished pieces that is not issued fine metal — e.g. copper mixed into 24K to make 18K. Say where it came from; the
              parts must total exactly {g(expectedAlloy)}g.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            {companyAlloy ? (
              <Field
                label="From Company Copper/Alloy (g)"
                name="companyAlloyInput"
                type="number"
                step="0.001"
                min={0}
                value={alloyTouched ? companyAlloyInput : g(defaultCompany)}
                onChange={(e) => editAlloy("company", e.target.value)}
              />
            ) : null}
            <Field
              label="Karigar-added alloy (g)"
              name="karigarAlloyInput"
              type="number"
              step="0.001"
              min={0}
              value={alloyTouched ? karigarAlloyInput : "0.000"}
              onChange={(e) => editAlloy("karigar", e.target.value)}
            />
            <Field
              label="Karigar alloy charge (₹)"
              name="karigarAlloyCostInput"
              type="number"
              step="0.01"
              min={0}
              value={karigarAlloyCost}
              onChange={(e) => setKarigarAlloyCost(e.target.value)}
            />
            <Field
              label="Included, no separate cost (g)"
              name="includedAlloyInput"
              type="number"
              step="0.001"
              min={0}
              value={alloyTouched ? includedAlloyInput : g(defaultIncluded)}
              onChange={(e) => editAlloy("included", e.target.value)}
            />
          </div>
          {companyAlloy ? (
            <div className="max-w-xs">
              <Field
                label="Returned Copper/Alloy (g)"
                name="returnedAlloyInput"
                type="number"
                step="0.001"
                min={0}
                value={returnedAlloy}
                onChange={(e) => setReturnedAlloy(e.target.value)}
              />
            </div>
          ) : null}
          <p className={`text-xs font-medium ${alloyMismatch ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400"}`}>
            {alloyMismatch
              ? `Split totals ${enteredAlloy !== null ? g(enteredAlloy) : "—"}g — must be exactly ${g(expectedAlloy)}g`
              : `Split balances: ${g(expectedAlloy)}g`}
          </p>
        </div>
      ) : null}

      {remainingDiamonds.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
          <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
            Remaining issued diamonds not set in an output ({remainingDiamonds.length})
          </h3>
          {remainingDiamonds.map((d) => (
            <div key={d.polishedDiamondId} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-zinc-700 dark:text-zinc-300">
                {d.polishedCode} · {d.shape} · {d.carat}ct
              </span>
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="radio"
                  name={`resolution-${d.polishedDiamondId}`}
                  checked={diamondResolutions[d.polishedDiamondId] === "RETURNED"}
                  onChange={() => setRemainingResolution(d.polishedDiamondId, "RETURNED")}
                />
                Return to stock
              </label>
              {isOwner ? (
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="radio"
                    name={`resolution-${d.polishedDiamondId}`}
                    checked={diamondResolutions[d.polishedDiamondId] === "DAMAGED_LOST"}
                    onChange={() => setRemainingResolution(d.polishedDiamondId, "DAMAGED_LOST")}
                  />
                  Damaged/Lost (Owner)
                </label>
              ) : null}
              <label className="flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                <input
                  type="radio"
                  name={`resolution-${d.polishedDiamondId}`}
                  checked={!diamondResolutions[d.polishedDiamondId]}
                  onChange={() => setRemainingResolution(d.polishedDiamondId, null)}
                />
                Leave with Karigar
              </label>
              {diamondResolutions[d.polishedDiamondId] === "DAMAGED_LOST" ? (
                <input
                  type="text"
                  placeholder="Reason (required)"
                  value={damagedLostReasons[d.polishedDiamondId] ?? ""}
                  onChange={(e) => setDamagedLostReasons((prev) => ({ ...prev, [d.polishedDiamondId]: e.target.value }))}
                  className="h-8 flex-1 min-w-[10rem] rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {pendingPackets.length > 0 ? (
        <div className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
          <div>
            <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Polished Diamond packet stones with the Karigar</h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Enter what was set, returned or damaged. Anything not entered stays pending with the Karigar — it is never counted as loss.
            </p>
          </div>
          {pendingPackets.map((p) => {
            const d = packetDrafts[p.packetId] ?? emptyPacketDraft();
            const status = packetStatus.find((s) => s.packet.packetId === p.packetId);
            return (
              <div key={p.packetId} className="flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
                <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                  {p.packetCode} · {p.label} · pending {p.pendingPieces} pcs / {p.pendingCarat}ct
                  {status?.fullyResolved ? <span className="ml-2 text-xs text-emerald-700 dark:text-emerald-400">fully resolved</span> : null}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-zinc-600 dark:text-zinc-400">Set</span>
                  <input
                    aria-label={`Set pieces — ${p.packetCode}`}
                    type="number"
                    min="0"
                    step="1"
                    placeholder="Pieces"
                    value={d.set.pieces}
                    onChange={(e) => updatePacketDraft(p.packetId, { set: { ...d.set, pieces: e.target.value } })}
                    className="h-8 w-20 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                  />
                  <input
                    aria-label={`Set carat — ${p.packetCode}`}
                    type="number"
                    min="0"
                    step="0.001"
                    placeholder="Carat"
                    value={d.set.carat}
                    onChange={(e) => updatePacketDraft(p.packetId, { set: { ...d.set, carat: e.target.value } })}
                    className="h-8 w-24 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                  />
                  {outputs.length > 1 ? (
                    <select
                      aria-label={`Output for set stones — ${p.packetCode}`}
                      value={d.setOutputIndex}
                      onChange={(e) => updatePacketDraft(p.packetId, { setOutputIndex: e.target.value })}
                      className="h-8 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                    >
                      {outputs.map((_, i) => (
                        <option key={i} value={String(i)}>
                          Output {i + 1}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-zinc-600 dark:text-zinc-400">Returned</span>
                  <input
                    aria-label={`Returned pieces — ${p.packetCode}`}
                    type="number"
                    min="0"
                    step="1"
                    placeholder="Pieces"
                    value={d.returned.pieces}
                    onChange={(e) => updatePacketDraft(p.packetId, { returned: { ...d.returned, pieces: e.target.value } })}
                    className="h-8 w-20 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                  />
                  <input
                    aria-label={`Returned carat — ${p.packetCode}`}
                    type="number"
                    min="0"
                    step="0.001"
                    placeholder="Carat"
                    value={d.returned.carat}
                    onChange={(e) => updatePacketDraft(p.packetId, { returned: { ...d.returned, carat: e.target.value } })}
                    className="h-8 w-24 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                  />
                </div>
                {isOwner ? (
                  <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-zinc-600 dark:text-zinc-400">Damaged/Lost (Owner)</span>
                  <input
                    aria-label={`Damaged/Lost (Owner) pieces — ${p.packetCode}`}
                    type="number"
                    min="0"
                    step="1"
                    placeholder="Pieces"
                    value={d.damaged.pieces}
                    onChange={(e) => updatePacketDraft(p.packetId, { damaged: { ...d.damaged, pieces: e.target.value } })}
                    className="h-8 w-20 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                  />
                  <input
                    aria-label={`Damaged/Lost (Owner) carat — ${p.packetCode}`}
                    type="number"
                    min="0"
                    step="0.001"
                    placeholder="Carat"
                    value={d.damaged.carat}
                    onChange={(e) => updatePacketDraft(p.packetId, { damaged: { ...d.damaged, carat: e.target.value } })}
                    className="h-8 w-24 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                  />
                    {Number(d.damaged.pieces) > 0 || Number(d.damaged.carat) > 0 ? (
                      <input
                        type="text"
                        placeholder="Reason (required)"
                        value={d.reason}
                        onChange={(e) => updatePacketDraft(p.packetId, { reason: e.target.value })}
                        className="h-8 flex-1 min-w-[10rem] rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                      />
                    ) : null}
                  </div>
                ) : null}
                {status?.problem ? <p className="text-xs font-medium text-red-600 dark:text-red-400">{status.problem}</p> : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {customerMode ? (
        <div className="flex flex-col gap-3 rounded-xl border border-sky-200 p-3 dark:border-sky-900" data-testid="customer-gold-outcomes">
          <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
            {customerName ?? "Customer"}&apos;s gold — returned, scrap{isOwner ? ", authorised loss" : ""}
          </h3>
          {mixedJob ? (
            <Field
              label="Customer's share of the finished pieces' fine gold (g)"
              name="customerShareInput"
              type="number"
              step="0.001"
              min={0}
              value={customerShare}
              onChange={(e) => setCustomerShare(e.target.value)}
              hint={`This job holds both Customer and Company gold (Owner-approved). Finished fine gold: ${g(outputsFine)}g — the rest is Company gold.`}
            />
          ) : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Customer gold returned unused (g gross)" name="customerReturnInput" type="number" step="0.001" min={0} value={customerReturn} onChange={(e) => setCustomerReturn(e.target.value)} />
            <Field label="Customer gold scrap (g gross) — stays the Customer's" name="customerScrapInput" type="number" step="0.001" min={0} value={customerScrap} onChange={(e) => setCustomerScrap(e.target.value)} />
            {isOwner ? (
              <>
                <Field
                  label="Authorised process loss (g fine, Owner)"
                  name="customerLossInput"
                  type="number"
                  step="0.001"
                  min={0}
                  value={customerLoss}
                  onChange={(e) => setCustomerLoss(e.target.value)}
                  hint="Only an explicit weight with a reason. Never inferred from what remains."
                />
                <Field label="Reason for the loss" name="customerLossReasonInput" value={customerLossReason} onChange={(e) => setCustomerLossReason(e.target.value)} maxLength={300} />
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {!customerMode || issuedFineBearing.length > 0 ? (
      <>
      <div className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
            {mixedJob ? "Company gold returned" : isGoldJob ? "Returned Gold" : "Returned unused metal"} ({g(returnedFine)}g fine)
          </h3>
          {fineBearing.length > 1 ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              This job issued more than one purity — say exactly which purity each returned amount belongs to.
            </p>
          ) : null}
        </div>
        {returnedLines.map((line, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Returned metal purity"
              value={line.purityId}
              onChange={(e) => updateReturnedLine(index, { purityId: e.target.value })}
              className="h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
            >
              <option value="">Choose purity…</option>
              {companyReturnPurities.map((p) => (
                <option key={p.purityId} value={p.purityId}>
                  {metalTypeLabel(p.metalType)} · {p.displayName}
                </option>
              ))}
            </select>
            <input
              aria-label="Returned gross weight"
              type="number"
              step="0.001"
              min="0"
              placeholder="Gross weight (g)"
              value={line.grossWeight}
              onChange={(e) => updateReturnedLine(index, { grossWeight: e.target.value })}
              className="h-10 w-40 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
            />
            {returnedLines.length > 1 ? (
              <button
                type="button"
                onClick={() => removeReturnedLine(index)}
                className="text-xs font-medium text-red-600 hover:underline dark:text-red-400"
              >
                Remove
              </button>
            ) : null}
          </div>
        ))}
        {fineBearing.length > 1 ? (
          <Button type="button" variant="secondary" size="md" onClick={addReturnedLine} className="self-start">
            + Add another returned-metal purity
          </Button>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Scrap ({g(scrapFine)}g fine)</h3>
          {fineBearing.length > 1 ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Say exactly which purity each scrap amount belongs to.</p>
          ) : null}
        </div>
        {scrapLines.map((line, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Scrap metal purity"
              value={line.purityId}
              onChange={(e) => updateScrapLine(index, { purityId: e.target.value })}
              className="h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
            >
              <option value="">Choose purity…</option>
              {companyReturnPurities.map((p) => (
                <option key={p.purityId} value={p.purityId}>
                  {metalTypeLabel(p.metalType)} · {p.displayName}
                </option>
              ))}
            </select>
            <input
              aria-label="Scrap gross weight"
              type="number"
              step="0.001"
              min="0"
              placeholder="Gross weight (g)"
              value={line.grossWeight}
              onChange={(e) => updateScrapLine(index, { grossWeight: e.target.value })}
              className="h-10 w-40 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
            />
            {scrapLines.length > 1 ? (
              <button
                type="button"
                onClick={() => removeScrapLine(index)}
                className="text-xs font-medium text-red-600 hover:underline dark:text-red-400"
              >
                Remove
              </button>
            ) : null}
          </div>
        ))}
        {fineBearing.length > 1 ? (
          <Button type="button" variant="secondary" size="md" onClick={addScrapLine} className="self-start">
            + Add another scrap purity
          </Button>
        ) : null}
      </div>
      </>
      ) : null}

      {customerMode || custodyMode || gap > ZERO ? (
        <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={markJobComplete}
            onChange={(e) => {
              setMarkJobComplete(e.target.checked);
              if (e.target.checked && custodyMode) setExplicitLoss(g(leftOnJobWithoutAllocation));
            }}
            className="h-4 w-4 rounded border-zinc-300"
          />
          {customerMode
            ? "This completes the job's gold — every gram of the Customer's gold on it is accounted for"
            : custodyMode
            ? "This completes the job — the Karigar's other unallocated gold stays in their balance"
            : "This completes the job — no more metal will come back from this Karigar"}
        </label>
      ) : null}
      {custodyMode && markJobComplete ? (
        <Field
          label="Process loss on this job (g fine)"
          name="explicitLossInput"
          type="number"
          step="0.001"
          min={0}
          value={explicitLoss}
          onChange={(e) => setExplicitLoss(e.target.value)}
          hint={`Enter the loss explicitly — it is never guessed. Metal left on this job after this receipt, before anything is taken from the balance: ${g(leftOnJobWithoutAllocation)}g fine. Any loss above that is taken from the Karigar's balance.`}
        />
      ) : null}

      {customerMode ? (
        <div className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 text-sm" aria-live="polite" data-testid="receipt-customer-gold-preview">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Customer-owned gold used</p>
            <Button type="button" variant="secondary" size="md" onClick={runCustomerPreview} disabled={cgPreviewPending || Boolean(blockReason) || Boolean(mixedStaffBlock)}>
              {cgPreviewPending ? "Checking…" : freshCustomerPreview ? "Preview again" : "Preview Customer gold"}
            </Button>
          </div>
          {blockReason ? <p className="text-xs font-medium text-red-600 dark:text-red-400">{blockReason}</p> : null}
          {mixedStaffBlock ? <Alert tone="error">{mixedStaffBlock}</Alert> : null}
          {customerPreviewError ? <Alert tone="error">{customerPreviewError}</Alert> : null}
          {freshCustomerPreview ? (
            <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
              <FragmentRow label="Source">
                {freshCustomerPreview.customerName}&apos;s {freshCustomerPreview.sourceLabel} ({freshCustomerPreview.sourceFineness}%) — Customer-owned, excluded from Company material cost
              </FragmentRow>
              {freshCustomerPreview.outputs.map((o, i) => (
                <FragmentRow key={i} label={`Piece ${i + 1}`}>
                  {o.netWeight}g net at {o.purityDisplayName} ({o.finenessPercent}%) = <strong>{o.fineWeight}g fine</strong> · Customer&apos;s {o.customerFine}g
                </FragmentRow>
              ))}
              <FragmentRow label="Customer gold in pieces">
                <strong>{freshCustomerPreview.customerFineForOutputs}g fine</strong>
                {freshCustomerPreview.mixed || freshCustomerPreview.companyFineForOutputs !== "0.000" ? ` · Company gold ${freshCustomerPreview.companyFineForOutputs}g fine` : ""}
              </FragmentRow>
              <FragmentRow label="Returned / scrap / loss">
                {freshCustomerPreview.returned.gross}g gross ({freshCustomerPreview.returned.fine}g fine) returned · {freshCustomerPreview.scrap.gross}g gross (
                {freshCustomerPreview.scrap.fine}g fine) scrap · {freshCustomerPreview.lossFine}g fine authorised loss
              </FragmentRow>
              <FragmentRow label="Needed">{freshCustomerPreview.neededFine}g fine</FragmentRow>
              <FragmentRow label="Already on this job">{freshCustomerPreview.onJobBefore.fine}g fine</FragmentRow>
              <FragmentRow label="Taken now">
                {freshCustomerPreview.fromKarigar.fine}g fine ({freshCustomerPreview.fromKarigar.gross}g gross) from {freshCustomerPreview.karigarName} ·{" "}
                {freshCustomerPreview.fromSafe.fine}g fine ({freshCustomerPreview.fromSafe.gross}g gross) from the safe
              </FragmentRow>
              <FragmentRow label="Customer balance after">
                with {freshCustomerPreview.karigarName} {freshCustomerPreview.karigarAfter.fine}g · safe {freshCustomerPreview.safeAfter.fine}g · on this job{" "}
                {freshCustomerPreview.onJobAfter.fine}g fine — still the Customer&apos;s
              </FragmentRow>
              {freshCustomerPreview.mixed ? (
                <FragmentRow label="Company gold (separate)">
                  <span data-testid="mixed-company-side">
                    on job {freshCustomerPreview.company.pendingBefore}g fine · in pieces {freshCustomerPreview.company.finishedFine}g · returned {freshCustomerPreview.company.returnedFine}g · scrap{" "}
                    {freshCustomerPreview.company.scrapFine}g · process loss {freshCustomerPreview.company.processLossFine}g · left pending {freshCustomerPreview.company.pendingAfter}g
                    {freshCustomerPreview.company.costMoved !== null ? ` · Company gold cost carried once: ₹${freshCustomerPreview.company.costMoved} (Customer gold ₹0)` : ""}
                  </span>
                </FragmentRow>
              ) : null}
              <FragmentRow label="Job">{freshCustomerPreview.completesJob ? "Customer gold completed (job completes when every stone is resolved)" : "Stays open"}</FragmentRow>
            </dl>
          ) : null}
          {freshCustomerPreview ? (
            <ChargesAndPosting charges={freshCustomerPreview.charges} posting={freshCustomerPreview.posting} />
          ) : cgPreviewState?.preview && !cgPreviewPending ? (
            <p className="text-xs font-medium text-amber-700 dark:text-amber-400">The receipt changed after the preview. Preview again before saving.</p>
          ) : !customerPreviewError ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Preview shows exactly how much of the Customer&apos;s gold is used and what remains theirs, before anything is saved.</p>
          ) : null}
        </div>
      ) : null}

      {!customerMode ? (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 text-sm" aria-live="polite">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Reconciliation (fine metal)</p>
        {custodyMode ? (
          <p>
            On this job{karigarAdded > ZERO ? " + Karigar-added" : ""}: <span className="font-semibold">{g(jobAvailable)}g</span> · Karigar&apos;s
            unallocated balance: <span className="font-semibold">{g(custodyFine)}g</span>
          </p>
        ) : (
          <p>
            Pending with Karigar{karigarAdded > ZERO ? " + Karigar-added" : ""}: <span className="font-semibold">{g(pendingAvailable)}g</span>
          </p>
        )}
        <p>
          {isGoldJob ? "Finished Fine Gold" : "Finished fine metal"}: <span className="font-semibold">{g(outputsFine)}g</span> ·{" "}
          {isGoldJob ? "Returned Gold" : "Returned"}: <span className="font-semibold">{g(returnedFine)}g</span> · Scrap:{" "}
          <span className="font-semibold">{g(scrapFine)}g</span>
        </p>
        {custodyMode ? (
          <p>
            {willCompleteMetal ? "Process Loss" : "Left on this job after this receipt"}:{" "}
            <span className="font-semibold">{willCompleteMetal ? g(previewLoss) : g(leftOnJobWithoutAllocation)}g</span>
            {!willCompleteMetal && jobGap < ZERO ? <> · shortfall taken from the Karigar&apos;s balance: <span className="font-semibold">{g(-jobGap)}g</span></> : null}
          </p>
        ) : (
          <p>
            {willCompleteMetal ? "Process Loss" : "Still with Karigar (not yet resolved)"}:{" "}
            <span className="font-semibold">{willCompleteMetal ? g(previewLoss) : g(gap > ZERO ? gap : ZERO)}g</span>
          </p>
        )}
        {expectedAlloy > ZERO ? (
          <p>
            Alloy Added: <span className="font-semibold">{g(expectedAlloy)}g</span>
          </p>
        ) : null}
        {blockReason ? (
          <p className="mt-1 text-xs font-medium text-red-600 dark:text-red-400">{blockReason}</p>
        ) : willCompleteJob ? (
          <p className="mt-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">Balances — this job will be marked Completed.</p>
        ) : willCompleteMetal ? (
          <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400">
            Metal is fully resolved, but unresolved diamonds remain — this job will stay Partially Received.
          </p>
        ) : (
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            {custodyMode
              ? "This job will be marked Partially Received. Tick “This completes the job” when nothing more is coming."
              : "Balances — this job will be marked Partially Received."}
          </p>
        )}
      </div>
      ) : null}

      {custodySource ? (
        <div className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 text-sm" aria-live="polite" data-testid="receipt-custody-preview">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Gold from Karigar Metal</p>
            <Button type="button" variant="secondary" size="md" onClick={runCustodyPreview} disabled={previewPending || Boolean(blockReason)}>
              {previewPending ? "Checking…" : freshPreview ? "Preview again" : "Preview gold allocation"}
            </Button>
          </div>
          {previewError ? <Alert tone="error">{previewError}</Alert> : null}
          {freshPreview ? (
            <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
              <FragmentRow label="Source">
                {freshPreview.karigarName} · {freshPreview.sourceLabel} ({freshPreview.sourceFineness}%)
              </FragmentRow>
              {freshPreview.outputs.map((o, i) => (
                <FragmentRow key={i} label={`Piece ${i + 1}`}>
                  {o.netWeight}g net metal at {o.purityDisplayName} ({o.finenessPercent}%) = <strong>{o.fineWeight}g fine</strong>
                </FragmentRow>
              ))}
              <FragmentRow label="Needed">
                <strong>{freshPreview.neededFine}g fine</strong> (finished {freshPreview.outputFine} + returned {freshPreview.returnedFine} + scrap{" "}
                {freshPreview.scrapFine} + loss {freshPreview.explicitLossFine})
              </FragmentRow>
              <FragmentRow label="Already on this job">{freshPreview.jobPendingFine}g fine</FragmentRow>
              <FragmentRow label="Taken from balance now">
                {freshPreview.allocation ? (
                  <>
                    <strong>{freshPreview.allocation.fineWeight}g fine</strong> = {freshPreview.allocation.grossWeight}g gross {freshPreview.sourceLabel}
                    {freshPreview.allocation.costValue !== null ? (
                      <>
                        {" "}
                        · cost <strong>₹{rupees(freshPreview.allocation.costValue)}</strong>
                      </>
                    ) : null}
                  </>
                ) : (
                  "Nothing — this job's own metal covers it"
                )}
              </FragmentRow>
              <FragmentRow label="Karigar balance">
                {freshPreview.custodyBefore.fine}g fine / {freshPreview.custodyBefore.gross}g gross → <strong>{freshPreview.custodyAfter.fine}g fine</strong> /{" "}
                {freshPreview.custodyAfter.gross}g gross remaining
                {freshPreview.custodyAfter.cost !== null ? ` (₹${rupees(freshPreview.custodyAfter.cost)})` : ""}
              </FragmentRow>
              <FragmentRow label="Left on this job">{freshPreview.jobPendingAfterReceipt}g fine</FragmentRow>
              <FragmentRow label="Job">{freshPreview.completesJob ? "Completes (if every stone is resolved)" : "Stays Partially Received"}</FragmentRow>
            </dl>
          ) : null}
          {freshPreview ? (
            <ChargesAndPosting charges={freshPreview.charges} posting={freshPreview.posting} />
          ) : previewState?.preview && !previewPending ? (
            <p className="text-xs font-medium text-amber-700 dark:text-amber-400">The receipt changed after the preview. Preview again before saving.</p>
          ) : !previewError ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Preview shows exactly how much gold is taken from the Karigar&apos;s balance and what remains, before anything is saved.
            </p>
          ) : null}
        </div>
      ) : null}

      {isOwner && willCompleteMetal && (previewLoss > ZERO || (companyAlloy && alloyPending > ZERO)) ? (
        <label className="flex items-start gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={isAbnormalLoss}
            onChange={(e) => setIsAbnormalLoss(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-zinc-300"
          />
          <span>
            Classify this loss as abnormal (Owner only) — posts to Business Expenses instead of being absorbed into the finished
            jewellery cost
          </span>
        </label>
      ) : null}
      {isAbnormalLoss ? (
        <input
          type="text"
          name="abnormalLossReason"
          placeholder="Reason for abnormal loss (required)"
          value={abnormalLossReason}
          onChange={(e) => setAbnormalLossReason(e.target.value)}
          className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        />
      ) : null}

      <div>
        <button
          type="button"
          onClick={() => setShowMore((v) => !v)}
          aria-expanded={showMore}
          className="text-sm font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
        >
          {showMore ? "Hide charges & notes" : "Labour, making, setting, plating charges & notes"}
        </button>
      </div>

      {/* Kept mounted when collapsed (only hidden): nothing typed here is ever unmounted, reset or omitted. */}
      <div
        hidden={!showMore}
        data-testid="receipt-charges-section"
        className={`${showMore ? "grid" : "hidden"} grid-cols-1 gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 sm:grid-cols-3`}
      >
        <Field label="Labour charge (₹)" name="labourChargeInput" type="number" step="0.01" min={0} value={labourCharge} onChange={(e) => setLabourCharge(e.target.value)} />
        <Field label="Making charge (₹)" name="makingChargeInput" type="number" step="0.01" min={0} value={makingCharge} onChange={(e) => setMakingCharge(e.target.value)} />
        <Field label="Setting charge (₹)" name="settingChargeInput" type="number" step="0.01" min={0} value={settingCharge} onChange={(e) => setSettingCharge(e.target.value)} />
        <Field label="Plating charge (₹)" name="platingChargeInput" type="number" step="0.01" min={0} value={platingCharge} onChange={(e) => setPlatingCharge(e.target.value)} />
        <Field label="Other job expense (₹)" name="otherExpenseInput" type="number" step="0.01" min={0} value={otherExpense} onChange={(e) => setOtherExpense(e.target.value)} />
        <Field label="Karigar-added fine metal (g)" name="karigarAddedFineWeightInput" type="number" step="0.001" min={0} value={karigarAddedFineWeight} onChange={(e) => setKarigarAddedFineWeight(e.target.value)} />
        <Field label="Karigar-added material cost (₹)" name="karigarAddedCostInput" type="number" step="0.01" min={0} value={karigarAddedCost} onChange={(e) => setKarigarAddedCost(e.target.value)} />
        <Field label="Notes (optional)" name="notesInput" value={notes} onChange={(e) => setNotes(e.target.value)} className="sm:col-span-2" />
      </div>
      {!showMore && Number(enteredCharges.total) !== 0 ? (
        <p className="text-xs text-zinc-600 dark:text-zinc-400" data-testid="collapsed-charges-summary">
          Charges entered: {chargeSummary(enteredCharges)}
        </p>
      ) : null}

      <Button type="submit" size="lg" disabled={pending || Boolean(blockReason) || Boolean(custodyBlock) || Boolean(customerBlock)} className="self-start">
        {pending ? "Saving…" : "Receive Finished Jewellery"}
      </Button>
    </form>
  );
}
