import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/jewellery/CreateJobForm", () => ({ CreateJobForm: () => null }));

import { JobsTab, type SerializedJewelleryJob } from "@/components/jewellery/JobsTab";
import { classifyGoldSource } from "@/lib/jewellery/jobGoldSource";
import { GOLD_SOURCE_LABELS } from "@/lib/jewellery/jobGoldSourceLabels";
import { jobListHref } from "@/lib/jewellery/jobListHref";
import { Decimal } from "@/lib/accounting/money";

const c = (customer: string, company: string, extra: Partial<{ cancelled: boolean; hasLiveReceipt: boolean; hasCustomerPiece: boolean; hasNonGoldMetal: boolean }> = {}) =>
  classifyGoldSource({ customerFine: new Decimal(customer), companyFine: new Decimal(company), cancelled: false, hasLiveReceipt: false, hasCustomerPiece: false, ...extra });

describe("gold source classification", () => {
  it("customer only, company only, both, neither", () => {
    expect(c("5.000", "0")).toBe("CUSTOMER");
    expect(c("0", "4.580")).toBe("COMPANY");
    expect(c("2", "1")).toBe("MIXED");
    expect(c("0", "0")).toBe("NONE");
  });
  it("a fully released / reversed contribution counts as nothing", () => {
    expect(c("0.000", "0.000")).toBe("NONE");
    expect(c("-0.000", "0")).toBe("NONE");
  });
  it("a cancelled job contributes nothing (its issues were reversed)", () => {
    expect(c("5", "5", { cancelled: true })).toBe("NONE");
  });
  it("records that cannot tell are 'Review required', never guessed", () => {
    expect(c("0", "0", { hasLiveReceipt: true })).toBe("REVIEW");
    expect(c("0", "0", { hasCustomerPiece: true })).toBe("REVIEW");
    expect(c("0", "3", { hasCustomerPiece: true })).toBe("COMPANY");
    expect(c("0", "0", { hasLiveReceipt: true, hasNonGoldMetal: true })).toBe("NONE"); // a silver job
    expect(c("0", "0", { hasCustomerPiece: true, hasNonGoldMetal: true })).toBe("REVIEW");
  });
});

describe("list URL", () => {
  it("keeps view, filters and search; leaves empty values out", () => {
    expect(jobListHref("COMPLETED", { customerId: "c1", karigarId: "", goldSource: "CUSTOMER", search: "ring" })).toBe(
      "/jewellery-jobs?tab=jobs&view=COMPLETED&jobCustomer=c1&goldSource=CUSTOMER&jobSearch=ring"
    );
    expect(jobListHref("PENDING", {})).toBe("/jewellery-jobs?tab=jobs&view=PENDING");
  });
});

const job = (over: Partial<SerializedJewelleryJob> = {}): SerializedJewelleryJob => ({
  id: "j1",
  jobCode: "ZL-JJOB-2026-000005",
  customerName: "RUTVIK DOBARIYA",
  karigarName: "BHARGAV JEWELLERY MAKING",
  goldSource: "CUSTOMER",
  jewelleryType: "RING",
  designName: "Solitaire",
  issueDate: "2026-10-01T00:00:00.000Z",
  expectedDeliveryDate: null,
  status: "COMPLETED",
  issuedMetalFineWeight: "4.580",
  pendingFineWeight: "0.000",
  totalManufacturingCost: null,
  ...over,
});
const base = { customers: [], karigars: [], purities: [], search: "", view: "COMPLETED" };

describe("job rows and filters", () => {
  it("every row labels Customer, Karigar, Gold source, status and pending metal", () => {
    render(<JobsTab {...base} isOwner={false} jobs={[job(), job({ id: "j2", jobCode: "ZL-JJOB-2026-000006", customerName: null, goldSource: "REVIEW", status: "IN_PROGRESS" })]} total={2} />);
    const rows = screen.getAllByTestId("job-row");
    expect(within(rows[0]).getByTestId("job-customer").textContent).toBe("RUTVIK DOBARIYA");
    expect(within(rows[0]).getByTestId("job-karigar").textContent).toBe("BHARGAV JEWELLERY MAKING");
    expect(within(rows[0]).getByTestId("job-gold-source").textContent).toBe("Customer Gold");
    expect(within(rows[0]).getByText("Completed")).toBeTruthy();
    expect(within(rows[0]).getByText("0.000g fine")).toBeTruthy();
    expect(within(rows[1]).getByTestId("job-customer").textContent).toBe("No customer selected");
    expect(within(rows[1]).getByTestId("job-gold-source").textContent).toBe(GOLD_SOURCE_LABELS.REVIEW);
  });

  it("Staff rows carry no ₹ figure; the Owner sees the manufacturing cost", () => {
    const { container, unmount } = render(<JobsTab {...base} isOwner={false} jobs={[job()]} />);
    expect(container.textContent).not.toMatch(/₹/);
    unmount();
    render(<JobsTab {...base} isOwner jobs={[job({ totalManufacturingCost: "18647.00" })]} />);
    expect(screen.getByTestId("job-row").textContent).toContain("₹18647.00");
  });

  it("view links and the job link keep the filters; Clear filters resets them but keeps the view", () => {
    const filters = { customerId: "c1", karigarId: "k1", goldSource: "CUSTOMER" };
    render(
      <JobsTab
        {...base}
        isOwner={false}
        jobs={[job()]}
        filters={filters}
        search="ring"
        filterCustomers={[{ id: "c1", name: "RUTVIK DOBARIYA", archived: false }]}
        filterKarigars={[{ id: "k1", name: "BHARGAV", archived: true }]}
      />
    );
    expect(screen.getByRole("link", { name: "Pending" }).getAttribute("href")).toBe("/jewellery-jobs?tab=jobs&view=PENDING&jobCustomer=c1&jobKarigar=k1&goldSource=CUSTOMER&jobSearch=ring");
    expect(screen.getByRole("link", { name: "View job" }).getAttribute("href")).toContain("jobCustomer=c1");
    expect(screen.getByTestId("filter-clear").getAttribute("href")).toBe("/jewellery-jobs?tab=jobs&view=COMPLETED");
    expect((screen.getByTestId("filter-jobCustomer") as HTMLInputElement).value).toBe("RUTVIK DOBARIYA");
    expect((screen.getByTestId("filter-jobKarigar") as HTMLInputElement).value).toBe("BHARGAV (archived)");
    expect((screen.getByTestId("filter-goldSource") as HTMLSelectElement).value).toBe("CUSTOMER");
    const hidden = screen.getByTestId("job-filters").querySelectorAll('input[type="hidden"]');
    expect([...hidden].map((h) => `${(h as HTMLInputElement).name}=${(h as HTMLInputElement).value}`)).toEqual(["tab=jobs", "view=COMPLETED", "jobCustomer=c1", "jobKarigar=k1"]);
  });

  it("no match: the filtered empty state offers Clear filters; unknown ids are reported", () => {
    render(<JobsTab {...base} isOwner={false} jobs={[]} total={0} filters={{ customerId: "", karigarId: "", goldSource: "MIXED" }} unavailableFilters={["Customer"]} />);
    expect(screen.getByTestId("job-empty").textContent).toContain("No jewellery jobs match these filters.");
    expect(within(screen.getByTestId("job-empty")).getByRole("link", { name: "Clear filters" })).toBeTruthy();
    expect(screen.getByTestId("filter-unavailable").textContent).toContain("Customer filter: Unavailable");
  });

  it("says when the list is capped", () => {
    render(<JobsTab {...base} isOwner={false} jobs={[job()]} total={450} limit={300} />);
    expect(screen.getByTestId("job-count").textContent).toContain("Showing the newest 1 of 450 jobs");
  });
});
