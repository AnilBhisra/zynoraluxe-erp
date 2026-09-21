# Phase 8 — Opening Gold Revaluation Preview (PRODUCTION, NOT APPLIED)

**Status: awaiting Owner approval. Nothing in this document has been applied.**
All figures were read from production in a `default_transaction_read_only = on`
session on 2026-09-21 and recomputed with the posting engine's own decimal rules
(money half-up at 2 dp, weight at 3 dp).

---

## 1. Two defects, not one

| # | Defect | Evidence |
|---|---|---|
| **D-1** | Opening metal stock was valued at **₹1,60,000** for 22.001 g (₹7,279.68 per fine gram) instead of **₹3,51,664** at the actual ₹16,000 per fine gram. Understated by **₹1,91,664**. | `metal_stock_movements` OPENING_IN row |
| **D-2** | **Opening metal stock posts no journal entry at all.** `createOpeningMetalStock` writes only a stock movement (`posting.ts:319-330`), so the ₹1,60,000 never reached the books. Account **1300 Metal Inventory is negative ₹57,342.60** — it has been credited by issues that were never debited by the opening. | production trial balance |

D-2 affects every database, not just this one. The correction below fixes both.

## 2. Where the opening metal is today

The 22.001 g has split into four places. Weighted-average costing is kept; the
opening **layer** is revalued and the pool average recomputed from it.

| Location | Weight | Old value | New value | Difference |
|---|---:|---:|---:|---:|
| Usable metal stock (24K pool) | 12.147 g gross | ₹1,02,657.40 | ₹1,93,361.21 | **+₹90,703.81** |
| Job `ZL-JJOB-2026-000068` WIP with Karigar | 5.828 g fine pending | ₹42,425.96 | ₹93,248.01 | **+₹50,822.05** |
| `ZL-FJ-2026-000086` metal (from Job 68) | 4.162 g fine | ₹30,298.01 | ₹66,592.00 | **+₹36,293.99** |
| `ZL-FJ-2026-000087` metal (from Job 69) | 1.854 g fine | ₹15,668.63 | ₹29,512.78 | **+₹13,844.15** |
| | | | **Total** | **+₹1,91,664.00** |

The allocation ties to the shortfall exactly, with no rounding remainder.

## 3. How each figure is derived

**Opening layer.** 21.979 g fine × ₹16,000 = **₹3,51,664.00**, i.e. ₹15,984.0007
per gross gram (was ₹7,272.3967). The stored 99.9% fineness snapshot is kept.

**Job 68** issued 10.000 g gross out of the opening layer alone:
10.000 × ₹15,984.0007 = **₹1,59,840.01** (was ₹72,723.97). Receipt 52 resolved
4.162 of 9.990 fine grams, so ₹1,59,840.01 × 4.162 ÷ 9.990 = **₹66,592.00** to the
finished piece and **₹93,248.01** left in WIP.

**Pool before the Job 69 issue** — this is why the job must not be valued at the
purchase rate:

| Layer | Gross | Old | New | Per gross gram |
|---|---:|---:|---:|---:|
| Opening remnant | 12.001 g | ₹87,276.03 | ₹1,91,823.99 | ₹15,984.0007 |
| Purchase `ZL-MP-2026-000057` | 2.000 g | ₹31,050.00 | ₹31,050.00 (correct, unchanged) | ₹15,525.0000 |
| **Weighted average** | **14.001 g** | ₹1,18,326.03 | ₹2,22,873.99 | **₹15,918.4337** |

**Job 69** issued 2.000 g: 2.000 × ₹15,918.4337 = **₹31,836.87**, not ₹31,050 —
the corrected average sits slightly above the purchase rate because the opening
gold was bought at ₹16,000. Of that, the 0.146 g returned carries
₹31,836.87 × 0.146 ÷ 2.000 = **₹2,324.09**, leaving **₹29,512.78** in the piece.

## 4. Exact vouchers to post

Two linked, balanced vouchers. No original movement, voucher, journal entry or
snapshot is rewritten.

**R1 — bring opening metal stock on to the books** (the entry D-2 never posted,
at the originally entered value so the two defects stay separately auditable):

| Account | Debit | Credit |
|---|---:|---:|
| 1300 Metal Inventory | ₹1,60,000.00 | |
| 3000 Opening Balance Equity | | ₹1,60,000.00 |

**R2 — opening valuation correction, allocated to where the metal now sits:**

| Account | Debit | Credit |
|---|---:|---:|
| 1300 Metal Inventory | ₹90,703.81 | |
| 1320 Jewellery WIP | ₹50,822.05 | |
| 1330 Finished Jewellery Inventory | ₹50,138.14 | |
| 3000 Opening Balance Equity | | ₹1,91,664.00 |

Total credited to 3000 = ₹3,51,664.00 = the corrected opening value.

## 5. Resulting balances and the agreement check

| Account | Now | After R1 | After R2 | Must equal |
|---|---:|---:|---:|---|
| 1300 Metal Inventory | −₹57,342.60 | ₹1,02,657.40 | **₹1,93,361.21** | usable pool ₹1,93,361.21 ✓ |
| 1320 Jewellery WIP | ₹42,425.96 | ₹42,425.96 | **₹93,248.01** | job 68 WIP ₹93,248.01 ✓ |
| 1330 Finished Jewellery | ₹86,594.68 | ₹86,594.68 | **₹1,36,732.82** | FJ-86 + FJ-87 ✓ |

Note that R1 alone makes 1300 agree with the stock ledger at the old basis
(₹1,02,657.40), which is independent confirmation that ₹1,60,000 is exactly what
was missing from the books.

**Finished piece costs** (metal + diamonds + labour, all unchanged except metal):

| Piece | Metal | Diamonds | Labour | Old total | New total |
|---|---:|---:|---:|---:|---:|
| ZL-FJ-2026-000086 | ₹66,592.00 | ₹20,102.04 | ₹6,571.00 | ₹56,971.05 | **₹93,265.04** |
| ZL-FJ-2026-000087 | ₹29,512.78 | ₹11,880.00 | ₹2,075.00 | ₹29,623.63 | **₹43,467.78** |

**Future COGS basis.** The usable pool moves from ₹8,451.2555 to **₹15,918.4334**
per gross gram, so the next metal issue is costed correctly without any further
intervention. Neither finished piece has been sold, so no COGS or profit figure
already posted is affected.

## 6. What applying this will require

- Owner-only, single transaction, idempotent, with a stored reason.
- Compensating `MetalRevaluation` records linked to each original movement,
  issue line, WIP balance and finished piece — the originals stay untouched.
- Re-verification after posting: stock quantities unchanged, every voucher
  debit = credit, 1300/1320/1330 equal to their stock-ledger values.

**Nothing above runs until the Owner approves this preview.**
