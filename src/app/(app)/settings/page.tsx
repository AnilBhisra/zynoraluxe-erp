import type { Metadata } from "next";

import { requireOwner } from "@/lib/auth/dal";
import { prisma } from "@/lib/db/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader, CardTitle } from "@/components/ui/Card";
import { CompanySettingsForm } from "@/components/settings/CompanySettingsForm";
import { AddStaffForm } from "@/components/settings/AddStaffForm";
import { StaffList } from "@/components/settings/StaffList";

export const metadata: Metadata = {
  title: "Settings · ZYNORALUXE",
};

export default async function SettingsPage() {
  // Owner-only, enforced server-side against the database — not just hidden
  // in the UI. Staff are redirected to /unauthorized before any data below
  // is fetched or rendered.
  await requireOwner();

  const [companySettings, staff] = await Promise.all([
    prisma.companySettings.findUnique({ where: { id: "default" } }),
    prisma.user.findMany({
      where: { role: "STAFF" },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, email: true, isActive: true },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Settings" description="Company details and Staff accounts." />

      <Card>
        <CardHeader>
          <CardTitle>Company details</CardTitle>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Shown on reports and used as defaults across the app.
          </p>
          <div className="mt-5">
            <CompanySettingsForm
              initialValues={{
                companyName: companySettings?.companyName ?? "",
                address: companySettings?.address ?? "",
                phone: companySettings?.phone ?? "",
                email: companySettings?.email ?? "",
                gstNumber: companySettings?.gstNumber ?? "",
                defaultCurrency: companySettings?.defaultCurrency ?? "INR",
                financialYearStartMonth: companySettings?.financialYearStartMonth ?? 4,
                financialYearStartDay: companySettings?.financialYearStartDay ?? 1,
              }}
            />
          </div>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Staff accounts</CardTitle>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Staff can sign in with the email and temporary password you set here. Deactivating
            an account blocks sign-in without deleting their history.
          </p>
          <div className="mt-5">
            <StaffList staff={staff} />
          </div>
          <div className="mt-6 border-t border-[var(--border)] pt-6">
            <h3 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
              Add a Staff account
            </h3>
            <AddStaffForm />
          </div>
        </CardHeader>
      </Card>
    </div>
  );
}
