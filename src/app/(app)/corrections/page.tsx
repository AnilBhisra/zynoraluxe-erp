import type { Metadata } from "next";

import { CorrectionHistoryView } from "@/components/corrections/CorrectionHistoryView";
import { CorrectionWorkbench } from "@/components/corrections/CorrectionWorkbench";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireOwner } from "@/lib/auth/dal";
import { listCorrections, listOpeningStockEntries } from "@/lib/corrections/history";

export const metadata: Metadata = {
  title: "Correction History · ZYNORALUXE",
};

/**
 * Owner-only. Corrections carry original and corrected COST values, so this
 * page is never rendered for Staff — requireOwner() redirects before any of
 * it is fetched, the same never-fetched-then-hidden rule the rest of the app
 * follows for cost data.
 */
export default async function CorrectionsPage() {
  await requireOwner();
  const [rows, openingEntries] = await Promise.all([listCorrections(), listOpeningStockEntries()]);

  return (
    <div>
      <PageHeader
        title="Correction History"
        description="Every correction, with the original entry, the corrected value, the reason and each affected record. Originals are never edited or deleted. / દરેક સુધારાની પૂરી વિગત — મૂળ એન્ટ્રી કદી બદલાતી નથી."
      />
      <CorrectionWorkbench entries={openingEntries} canPost />
      <CorrectionHistoryView rows={rows} />
    </div>
  );
}
