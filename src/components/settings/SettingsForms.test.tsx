import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";

// Reproduces the real /settings page layout: CompanySettingsForm and
// AddStaffForm mounted together on one page, each with its own field
// literally named "email" — this is the exact scenario that used to produce
// duplicate id="email" elements in the DOM before the Field/useFieldId fix.
const mockUpdateCompanySettings = vi.fn();
const mockCreateStaffAccount = vi.fn();

vi.mock("@/app/actions/settings", () => ({
  updateCompanySettings: (...args: unknown[]) => mockUpdateCompanySettings(...args),
  createStaffAccount: (...args: unknown[]) => mockCreateStaffAccount(...args),
}));

import { CompanySettingsForm } from "./CompanySettingsForm";
import { AddStaffForm } from "./AddStaffForm";

function assertNoDuplicateIds(container: HTMLElement) {
  const ids = Array.from(container.querySelectorAll("[id]")).map((el) => el.id);
  const seen = new Set<string>();
  const duplicates = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  expect(duplicates).toEqual([]);
}

function assertEveryLabelTargetExists(container: HTMLElement) {
  const labels = Array.from(container.querySelectorAll("label[for]"));
  for (const label of labels) {
    const target = label.getAttribute("for")!;
    expect(container.querySelector(`#${CSS.escape(target)}`)).not.toBeNull();
  }
}

function renderSettingsPage() {
  return render(
    <>
      <CompanySettingsForm
        initialValues={{
          companyName: "Zynoraluxe",
          address: "",
          phone: "",
          // Non-empty so the "More details" section (which holds the Email
          // field) starts expanded, matching a company that already has one
          // saved — no extra click needed to reveal the collision.
          email: "company@example.com",
          gstNumber: "",
          companyStateCode: "",
          defaultCurrency: "INR",
          financialYearStartMonth: 4,
          financialYearStartDay: 1,
        }}
      />
      <AddStaffForm />
    </>
  );
}

describe("Settings page (CompanySettingsForm + AddStaffForm mounted together)", () => {
  beforeEach(() => {
    mockUpdateCompanySettings.mockReset().mockResolvedValue(undefined);
    mockCreateStaffAccount.mockReset().mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("gives the two independent Email fields distinct, non-colliding ids", () => {
    const { container } = renderSettingsPage();

    assertNoDuplicateIds(container);
    assertEveryLabelTargetExists(container);

    // AddStaffForm's Email is `required` (Field appends a " *" marker to the
    // label text), CompanySettingsForm's isn't — match both with a prefix
    // regex rather than an exact "Email" string.
    const emailInputs = screen.getAllByLabelText(/^email/i) as HTMLInputElement[];
    expect(emailInputs).toHaveLength(2);
    expect(emailInputs[0].id).not.toBe(emailInputs[1].id);
    // Both keep the same form-submission `name` — only `id`/`htmlFor` differ.
    expect(emailInputs[0].name).toBe("email");
    expect(emailInputs[1].name).toBe("email");
  });

  it("clicking each Email label focuses only that form's own Email input", async () => {
    const user = userEvent.setup();
    renderSettingsPage();

    const emailLabels = screen.getAllByText(/^email/i);
    const emailInputs = screen.getAllByLabelText(/^email/i) as HTMLInputElement[];
    const [companyEmailInput, staffEmailInput] = emailInputs;

    await user.click(emailLabels[0]);
    expect(document.activeElement).toBe(companyEmailInput);

    await user.click(emailLabels[1]);
    expect(document.activeElement).toBe(staffEmailInput);
  });

  it("still submits the Company settings form with its own email, independent of the Staff form", async () => {
    const user = userEvent.setup();
    renderSettingsPage();

    const [companyEmailInput] = screen.getAllByLabelText(/^email/i) as HTMLInputElement[];
    await user.clear(companyEmailInput);
    await user.type(companyEmailInput, "updated-company@example.com");

    await user.click(screen.getByRole("button", { name: /save company settings/i }));

    expect(mockUpdateCompanySettings).toHaveBeenCalledTimes(1);
    expect(mockCreateStaffAccount).not.toHaveBeenCalled();
    const submittedFormData = mockUpdateCompanySettings.mock.calls[0][1] as FormData;
    expect(submittedFormData.get("email")).toBe("updated-company@example.com");
  });

  it("still submits the Add Staff form with its own email, independent of the Company settings form", async () => {
    const user = userEvent.setup();
    renderSettingsPage();

    // "Name" (not "Company name") uniquely identifies AddStaffForm's field.
    await user.type(screen.getByLabelText(/^name/i), "New Staff");
    const [, staffEmailInput] = screen.getAllByLabelText(/^email/i) as HTMLInputElement[];
    await user.type(staffEmailInput, "staff@example.com");
    await user.type(screen.getByLabelText(/^temporary password/i), "a-strong-password");

    await user.click(screen.getByRole("button", { name: /add staff account/i }));

    expect(mockCreateStaffAccount).toHaveBeenCalledTimes(1);
    expect(mockUpdateCompanySettings).not.toHaveBeenCalled();
    const submittedFormData = mockCreateStaffAccount.mock.calls[0][1] as FormData;
    expect(submittedFormData.get("email")).toBe("staff@example.com");
    expect(submittedFormData.get("name")).toBe("New Staff");
  });
});
