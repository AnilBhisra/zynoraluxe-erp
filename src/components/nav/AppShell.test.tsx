import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
}));

vi.mock("@/app/actions/auth", () => ({
  logout: vi.fn(),
}));

import { AppShell } from "./AppShell";
import { getVisibleNavItems } from "@/lib/nav";
import type { CurrentUser } from "@/lib/auth/dal";

function renderShell(role: CurrentUser["role"]) {
  const user: CurrentUser = { id: "u1", name: "Asha Owner", email: "a@b.com", role };
  return render(
    <AppShell user={user} items={getVisibleNavItems(role)}>
      <p>page content</p>
    </AppShell>
  );
}

describe("AppShell navigation", () => {
  it("shows Settings to an Owner", () => {
    renderShell("OWNER");
    // Sidebar renders once, mobile drawer nav only exists once opened, so a
    // single match is expected.
    expect(screen.getByRole("link", { name: /settings/i })).toBeInTheDocument();
  });

  it("hides Settings and Costing from Staff", () => {
    renderShell("STAFF");
    expect(screen.queryByRole("link", { name: /settings/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /costing/i })).not.toBeInTheDocument();
  });

  it("shows Costing to an Owner", () => {
    renderShell("OWNER");
    expect(screen.getByRole("link", { name: /costing/i })).toBeInTheDocument();
  });

  it("always shows Dashboard, Accounting and Diamond and Jewellery Job to Staff", () => {
    renderShell("STAFF");
    for (const label of ["Dashboard", "Accounting", "Diamond", "Jewellery Job"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
  });

  it("shows the Help / મદદ nav item to an Owner", () => {
    renderShell("OWNER");
    expect(screen.getByRole("link", { name: "Help / મદદ" })).toHaveAttribute("href", "/help");
  });

  it("shows the Help / મદદ nav item to Staff too", () => {
    renderShell("STAFF");
    expect(screen.getByRole("link", { name: "Help / મદદ" })).toHaveAttribute("href", "/help");
  });

  it("renders the signed-in user's name and role", () => {
    renderShell("OWNER");
    expect(screen.getByText("Asha Owner")).toBeInTheDocument();
    expect(screen.getByText("Owner")).toBeInTheDocument();
  });
});
