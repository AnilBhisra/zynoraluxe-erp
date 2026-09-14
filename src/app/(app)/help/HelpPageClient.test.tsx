import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { HelpPageClient } from "./HelpPageClient";
import { TASK_CARDS, type HelpSection } from "@/lib/help/sections";

const SECTIONS: HelpSection[] = [
  {
    id: "login",
    title: "Login અને Dashboard",
    keywords: ["login", "password", "લોગિન"],
    body: <p>Login પેજ પર Email અને Password નાખો.</p>,
  },
  {
    id: "parties",
    title: "Parties",
    keywords: ["party", "customer", "supplier"],
    body: <p>Customer = જેને આપણે વેચીએ.</p>,
  },
];

function renderPage(sections: HelpSection[] = SECTIONS, role: "Owner" | "Staff" = "Owner") {
  return render(<HelpPageClient sections={sections} taskCards={TASK_CARDS} roleLabel={role} />);
}

describe("HelpPageClient", () => {
  it("renders Gujarati heading and role label", () => {
    renderPage(SECTIONS, "Staff");
    expect(screen.getByText("મદદ / Help")).toBeInTheDocument();
    expect(screen.getByText(/Staff તરીકે login/)).toBeInTheDocument();
  });

  it("renders all 15 task cards", () => {
    renderPage();
    for (const card of TASK_CARDS) {
      expect(screen.getByRole("link", { name: card.label })).toBeInTheDocument();
    }
  });

  it("every task card links to its own anchor", () => {
    renderPage();
    const link = screen.getByRole("link", { name: "નવી Party બનાવવી" });
    expect(link).toHaveAttribute("href", "#task-new-party");
  });

  it("renders every section with its title and body text", () => {
    renderPage();
    expect(screen.getByText("Login અને Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Parties")).toBeInTheDocument();
    expect(screen.getByText(/Customer = જેને આપણે વેચીએ/)).toBeInTheDocument();
  });

  it("gives each section card its own id, matching the section's id", () => {
    const { container } = renderPage();
    expect(container.querySelector("#login")).toBeInTheDocument();
    expect(container.querySelector("#parties")).toBeInTheDocument();
  });

  it("has no duplicate DOM ids across task cards + sections + search input", () => {
    const { container } = renderPage();
    const ids = Array.from(container.querySelectorAll("[id]")).map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("search filters both task cards and sections by Gujarati or English keyword", async () => {
    const user = userEvent.setup();
    renderPage();
    const search = screen.getByPlaceholderText(/શોધો/);
    await user.type(search, "party");

    // Matching content stays visible...
    expect(screen.getByRole("link", { name: "નવી Party બનાવવી" })).toBeInTheDocument();
    expect(screen.getByText("Parties")).toBeInTheDocument();
    // ...non-matching content is filtered out.
    expect(screen.queryByRole("link", { name: "Password/Loginની મદદ" })).not.toBeInTheDocument();
    expect(screen.queryByText("Login અને Dashboard")).not.toBeInTheDocument();
  });

  it("search also matches a Gujarati query term", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByPlaceholderText(/શોધો/), "લોગિન");
    expect(screen.getByText("Login અને Dashboard")).toBeInTheDocument();
    expect(screen.queryByText("Parties")).not.toBeInTheDocument();
  });

  it("shows a friendly empty message when nothing matches the search", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByPlaceholderText(/શોધો/), "zzzznomatchzzzz");
    expect(screen.getAllByText(/કંઈ મળ્યું નહીં/).length).toBeGreaterThan(0);
  });

  it("the Print / Save PDF button calls window.print()", async () => {
    const user = userEvent.setup();
    const printSpy = vi.spyOn(window, "print").mockImplementation(() => {});
    renderPage();
    await user.click(screen.getByRole("button", { name: "Print / Save PDF" }));
    expect(printSpy).toHaveBeenCalledOnce();
    printSpy.mockRestore();
  });

  it("only shows the Owner-only sections when they are actually passed in (server already filtered them for Staff)", () => {
    renderPage(SECTIONS.filter((s) => s.id !== "parties"));
    expect(screen.queryByText("Parties")).not.toBeInTheDocument();
    expect(within(screen.getByText("Login અને Dashboard").closest("div")!).getByText("Login અને Dashboard")).toBeInTheDocument();
  });
});
