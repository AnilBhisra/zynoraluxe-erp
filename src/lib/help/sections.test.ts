import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { getHelpSections, TASK_CARDS } from "./sections";

/** Renders every section's body to plain HTML text so the test can search
 * it like a real Server Component RSC response would be searched — the
 * same technique used to prove Staff never receives Owner-only cost data
 * elsewhere in this app (see FinishedStockTab / Phase 6 verification). */
function renderAll(role: "OWNER" | "STAFF") {
  const sections = getHelpSections(role);
  return sections.map((s) => ({ id: s.id, html: renderToStaticMarkup(s.body as never) }));
}

// Deliberately specific to Owner-only FEATURES (buttons/pages/admin
// controls) — not generic vocabulary. Staff legitimately needs to know a
// Sale affects "stock and accounting together" (e.g. the word "COGS"
// appears once, in passing, in the general Accounting section, exactly
// like the real Finished-Sale form's own on-screen copy) without ever
// seeing an actual cost FIGURE or an Owner-only BUTTON/PAGE.
const OWNER_ONLY_TERMS = [
  "Markup %",
  "Target margin %",
  "Cost Sheet",
  "Compare vs Costing",
  "Add a Staff account",
  "Metal/Purity master",
  "Company details",
  "COGS",
  "profit",
  "margin",
  "inventory value",
  "internal cost",
];

describe("getHelpSections — role-based content", () => {
  it("gives the Owner the Costing and Settings sections", () => {
    const sections = getHelpSections("OWNER");
    expect(sections.some((s) => s.id === "costing")).toBe(true);
    expect(sections.some((s) => s.id === "settings")).toBe(true);
  });

  it("never includes the Costing or Settings sections for Staff — not merely hidden, absent from the array entirely", () => {
    const sections = getHelpSections("STAFF");
    expect(sections.some((s) => s.id === "costing")).toBe(false);
    expect(sections.some((s) => s.id === "settings")).toBe(false);
    expect(sections.some((s) => s.ownerOnly)).toBe(false);
  });

  it("Staff's rendered section content contains none of the Owner-only cost/profit/admin terms", () => {
    const rendered = renderAll("STAFF");
    const combined = rendered.map((r) => r.html).join("\n");
    for (const term of OWNER_ONLY_TERMS) {
      expect(combined).not.toContain(term);
    }
  });

  it("Owner's rendered content DOES include the Costing/Settings terms (proves the Staff-side absence above is a real filter, not an empty manual)", () => {
    const rendered = renderAll("OWNER");
    const combined = rendered.map((r) => r.html).join("\n");
    expect(combined).toContain("Compare vs Costing");
    expect(combined).toContain("Staff account");
  });

  it("every section has a unique id, both for Owner and for Staff", () => {
    for (const role of ["OWNER", "STAFF"] as const) {
      const ids = getHelpSections(role).map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("gives Staff every general-audience section (nothing is missing besides the two Owner-only ones)", () => {
    const staffIds = getHelpSections("STAFF").map((s) => s.id);
    expect(staffIds).toEqual([
      "login",
      "parties",
      "accounting",
      "diamond",
      "metal-jewellery",
      "finished-stock-sales",
      "daily-checklist",
      "troubleshooting",
    ]);
  });

  it("real UI button text appears verbatim (spot-check against the audited labels) — never an invented name", () => {
    const rendered = renderAll("STAFF");
    const combined = rendered.map((r) => r.html).join("\n");
    // Verbatim strings confirmed to exist in the real UI.
    expect(combined).toContain("New Purchase");
    expect(combined).toContain("Sell Finished Jewellery");
    expect(combined).toContain("Other / Accounting-only Sale");
    expect(combined).toContain("Return (Sellable)");
    expect(combined).toContain("Return (Damaged)");
    expect(combined).toContain("Mark In Progress");
    expect(combined).toContain("This completes the job");
  });
});

describe("TASK_CARDS — the quick chooser", () => {
  it("has exactly the 15 required task cards", () => {
    expect(TASK_CARDS).toHaveLength(15);
  });

  it("every task card has a unique id and a unique anchor", () => {
    expect(new Set(TASK_CARDS.map((c) => c.id)).size).toBe(TASK_CARDS.length);
    expect(new Set(TASK_CARDS.map((c) => c.anchor)).size).toBe(TASK_CARDS.length);
  });

  it("every task card's anchor exists as a real heading id inside the Staff-visible sections (so every card actually navigates somewhere for both roles)", () => {
    const rendered = renderAll("STAFF");
    const combinedHtml = rendered.map((r) => r.html).join("\n");
    for (const card of TASK_CARDS) {
      expect(combinedHtml).toContain(`id="${card.anchor}"`);
    }
  });

  it("contains no secrets or real personal data (email/phone-shaped strings) anywhere in the rendered manual", () => {
    const rendered = [...renderAll("OWNER")];
    const combined = rendered.map((r) => r.html).join("\n");
    expect(combined).not.toMatch(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    expect(combined).not.toMatch(/\b[6-9]\d{9}\b/); // Indian 10-digit mobile pattern
  });
});

describe("Contextual module-page મદદ links resolve to real sections", () => {
  it("every module page's HelpLink anchor is a real Owner-visible section id", () => {
    const ownerIds = new Set(getHelpSections("OWNER").map((s) => s.id));
    for (const anchor of ["accounting", "diamond", "metal-jewellery", "costing", "settings"]) {
      expect(ownerIds.has(anchor)).toBe(true);
    }
  });

  it("the Accounting/Diamond/Jewellery-Jobs મદદ links (used by both roles) resolve for Staff too", () => {
    const staffIds = new Set(getHelpSections("STAFF").map((s) => s.id));
    for (const anchor of ["accounting", "diamond", "metal-jewellery"]) {
      expect(staffIds.has(anchor)).toBe(true);
    }
  });
});
