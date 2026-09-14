import type { Metadata } from "next";

import { requireUser } from "@/lib/auth/dal";
import { getHelpSections, TASK_CARDS } from "@/lib/help/sections";
import { HelpPageClient } from "./HelpPageClient";

export const metadata: Metadata = {
  title: "Help / મદદ · ZYNORALUXE",
};

export default async function HelpPage() {
  const user = await requireUser();
  // Computed server-side, keyed off the session-verified role — an Owner-
  // only section is simply never added to this array for a Staff request,
  // so no Owner-only text is ever part of the Staff RSC response (the same
  // never-fetched-then-hidden pattern used throughout this app for cost
  // data — see src/lib/jewellery/reports.ts's `includeCost`).
  const sections = getHelpSections(user.role);

  return (
    <HelpPageClient
      sections={sections}
      taskCards={TASK_CARDS}
      roleLabel={user.role === "OWNER" ? "Owner" : "Staff"}
    />
  );
}
