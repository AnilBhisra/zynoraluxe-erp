# ZYNORALUXE ERP — "Correct entry" support matrix

Audited against `dd477b5` (production on 2026-10-05). Every Job, Issue and Receipt
type, how it can be corrected today, and what this branch adds. A type is marked
**Supported** only where a correction has real-database tests and an Owner UI.

## Correction policy (all types)

| Record state | Method |
|---|---|
| Draft / unposted, nothing depends on it | ordinary edit (existing forms) |
| Posted | never overwritten or deleted. An immutable `Correction` (before snapshot, after snapshot, reason ≥ 10 characters, actor, preview fingerprint, idempotency key, POSTED / REVERSED) plus one `CorrectionImpact` row per changed field. The original record, its voucher and its history stay visible. |

Correction classes behind the one framework (`src/lib/corrections/entry/`):

1. **Metadata** — notes, instructions, references, non-posting dates. No stock, no
   voucher. Before → After kept as impacts. Reversible while the field still holds
   the corrected value.
2. **Non-financial quantity** — a count that no carat, cost, charge or loss depends
   on (processed-rough returned pieces). No voucher. Balance, snapshot and a
   compensating stock-ledger movement change atomically. Refused when anything
   downstream uses the row, or when the job's charge is per piece (then the count
   is financial).
3. **Stock / accounting** — weight, carat, cost, charge, purity, loss, outcome.
   Previewed stock and journal lines; posted through an existing audited mechanism
   or as an explicit mirror (`CORRECTION` voucher). A posted voucher is never edited.

Dependencies are re-checked at Preview and again at Confirm inside the locked
transaction; the preview fingerprint must still match; chains reverse newest-first.

## Matrix

Legend — **S** supported (DB tests + Owner UI) · **E** existing audited mechanism
(already live) · **N** new in this branch · **—** not supported (reason given).

| # | Type | Editable / correctable fields | Stock / accounting effect | Safe correction method | Blocking dependencies | Existing reversal reused | Status |
|---|---|---|---|---|---|---|---|
| 1 | Rough purchase lot | lot / stone details before first issue | Dr 1200 / Cr payable or bank | cost-split override (before issue); stone → parcel conversion (before issue); Opening/metal corrections do not apply | any issue of a row | conversion (audited) | **E** (split override, stone→parcel) · — full purchase reversal |
| 2 | Rough piece / parcel | colour, clarity, note | none | edit before first issue | issue | — | **E** (before issue) |
| 3 | Diamond Manufacturer job — Issue Rough | notes, due date, shape instruction / measurements | Dr 1210 / Cr 1200 | **metadata: N**; wrong rows/carat: cancel the job (no receipt yet) and issue again | any receipt | `cancelDiamondJob` (merges parcel portions back) | **S** (cancel, E) · **N** metadata |
| 4 | Receive Processed Rough (4P / Laser, HPHT / Grow, Rough Polish) — partial or final, batch or individual | returned pieces · notes · carat / charge / loss | Dr 1200 / Cr 1210 / Cr Manufacturer payable; loss movement | **pieces: N (quantity class)** · **notes: N** · carat / charge / loss: **N receipt reversal** (mirror CORRECTION voucher) then re-enter the receipt | returned row issued to a live job, split, partly issued, not Available; a later receipt on the job; an active correction on the receipt; per-piece charge (pieces only) | — (none existed) | **N** |
| 5 | Receive Polished (stones / packets) | labour (additions) · notes | Dr 1220 / Cr 1210 / Cr payable | Manufacturer labour correction **E** · notes **N** · stones / carat / outcome — not supported | stone or packet moved, certified, converted, issued | `reverseReceiptLabourCorrection` | **E** labour · **N** notes · — polished receipt reversal |
| 6 | Polished purchase | — | Dr 1220 / Cr payable | `cancelPolishedPurchase` before any use | any packet movement | yes | **E** |
| 7 | Polished stone → parcel conversion, packet adjustment | — | packet ledger | adjustment entries (audited) | — | adjustments | **E** |
| 8 | Job Manufacturer (packet process) issue / return | — | packet ledger, payable | `cancelPacketProcessJob` before return | a return | yes | **E** (cancel) · — return correction |
| 9 | Jewellery Job — header | notes, special instructions, expected delivery date, Customer reference | none | **metadata: N** | — | — | **N** |
| 10 | Jewellery material issue (metal, diamonds, packets) | — | Dr 1320 / Cr stock | `cancelJewelleryJob` before any receipt; metal revaluation (Phase 8) for value | a receipt | yes | **E** |
| 11 | Karigar Metal custody (issue / return / allocate / release) | — | Dr 1320 / Cr 1300 (issue, return) | `reverseCustodyEntry`, newest-first | later custody entry, receipt using it | yes | **E** |
| 12 | Jewellery receipt — Company gold / Karigar Metal | charges (additions) · notes | Dr 1330 / Cr 1320 / Cr payable; scrap / return pools | missing-charge correction **E** · notes **N** · weight / purity / outcome — not supported | piece sold, adjusted, revalued, transferred; metal returned to stock | `reverseReceiptChargeCorrection` | **E** charges · **N** notes · — Company receipt reversal |
| 13 | Jewellery receipt — Customer Gold / mixed | everything (by reversal + new receipt) · notes | 1340 / 1320 / payable; Customer gold ledger | Customer Gold receipt reversal **E** then re-enter · notes **N** | piece delivered / billed; later receipt; Company metal moved to stock | `reverseCustomerGoldJobReceipt` | **E** · **N** notes |
| 14 | Job-to-job metal transfer | — | memo (no voucher) | `reverseJobMetalTransfer` | destination received or moved it | yes | **E** |
| 15 | Customer Gold intake / movements / purchase / exchange | — | Customer gold ledger; AP for purchases | `reverseCustomerGoldEntry`, `reverseCustomerGoldPurchase`, newest-first | later entry / credit used | yes | **E** |
| 16 | Customer jewellery bill / delivery | — | AR / Sales / GST; COGS / 1340 | `reverseCustomerJewelleryBill` / `reverseCustomerJewelleryDelivery` | later delivery depends | yes | **E** |
| 17 | Finished sale / return / stock adjustment | — | Sales, COGS, 1330 | `cancelFinishedJewellerySale`, returns, adjustments | later return | yes | **E** |
| 18 | Metal purchase / opening stock / metal adjustment | rate, weight (opening) | 1300 | Phase 8 opening-stock correction (draft → approve), revaluation, `reverseMetalStockAdjustment` | revaluation chain | yes | **E** |
| 19 | Costing documents | draft fields | none (frozen snapshot on finalise) | draft edit; `reviseCostSheet` (new revision, snapshot kept) | finalised snapshot is immutable by design | revision | **E** |
| 20 | Corrections themselves | — | as posted | `reverseCorrection` (newest-first), batch reversal | a later correction depending on it | yes | **E** · **N** entry-correction reversal |

## Not supported (blocked, with reason)

- **Polished receipt reversal** (stones, packets, certification, outcomes): outputs
  are routinely certified, converted or issued within minutes; a safe reversal
  needs per-output dependency checks across the packet ledger. Labour additions
  remain correctable (row 5).
- **Company jewellery receipt reversal** (row 12): undoing metal returned to stock
  or scrap would re-cost the shared pools; Phase 8 revaluation remains the path for value.
- **Count corrections on multi-stone individual returns**: each row is a separately
  weighed stone; changing the count would invent weights. Reverse the receipt and
  re-enter it instead.
