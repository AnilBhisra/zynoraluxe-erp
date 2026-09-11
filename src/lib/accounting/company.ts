import "server-only";

import { prisma } from "@/lib/db/prisma";

const DEFAULT_FY_START_MONTH = 4;
const DEFAULT_FY_START_DAY = 1;

/** Company settings may not exist yet (Owner hasn't saved them). Falls back
 * to the same defaults the schema itself uses (1 April), so accounting can
 * still function before Settings is filled in. */
export async function getCompanyFySettings(): Promise<{
  fyStartMonth: number;
  fyStartDay: number;
  stateCode: string | null;
  defaultCurrency: string;
}> {
  const settings = await prisma.companySettings.findUnique({ where: { id: "default" } });
  return {
    fyStartMonth: settings?.financialYearStartMonth ?? DEFAULT_FY_START_MONTH,
    fyStartDay: settings?.financialYearStartDay ?? DEFAULT_FY_START_DAY,
    stateCode: settings?.companyStateCode ?? null,
    defaultCurrency: settings?.defaultCurrency ?? "INR",
  };
}
