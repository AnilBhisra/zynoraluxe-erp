import type { ClearingDocumentRow, ClearingReportRow } from "@/lib/accounting/clearingReports";
import { CLEARING_REPORT_COLUMNS, docStatusLabel } from "@/components/accounting/ClearingReportView";

/** One CSV cell: quoted when needed; text a spreadsheet would run as a formula is neutralised (numbers stay numbers). */
function cell(value: string): string {
  const isNumber = /^-?\d+(\.\d+)?$/.test(value);
  const safe = !isNumber && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) || safe !== value ? `"${safe.replace(/"/g, '""')}"` : safe;
}
const row = (xs: string[]) => xs.map(cell).join(",");

/** The Clearing Settlements report as CSV: provider summary, then every settlement row — the same filters as the screen. */
export function clearingReportCsv(rows: ClearingReportRow[], docs: ClearingDocumentRow[]): string {
  const out = [row(["Provider", "Currency", ...CLEARING_REPORT_COLUMNS.map((c) => c.label), "Unallocated settled (fc)", "Closing (fc)", "Closing reserve"])];
  for (const r of rows) {
    out.push(row([r.partyName, r.currencyCode, ...CLEARING_REPORT_COLUMNS.map((c) => (r[c.key] as { toFixed: (n: number) => string }).toFixed(2)), r.unallocatedFc.toFixed(2), r.closingFc.toFixed(2), r.closingReserveInr.toFixed(2)]));
  }
  out.push("");
  out.push(row(["Date", "Code", "Provider", "Reference", "Currency", "Settled (fc)", "INR value", "Bank amount", "Deductions", "Remaining (fc)", "Status", "Reversal"]));
  for (const d of docs) {
    out.push(row([d.date, d.voucherNumber, d.partyName, d.reference ?? "", d.currencyCode, d.availableFc.toFixed(2), d.availableInr.toFixed(2), d.receivedInr.toFixed(2), d.deductionsInr.toFixed(2), d.availableAfterFc.toFixed(2), docStatusLabel(d), d.reversalVoucherNumber ?? ""]));
  }
  return out.join("\r\n") + "\r\n";
}
