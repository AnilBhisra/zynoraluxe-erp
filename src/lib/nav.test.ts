import { describe, expect, it } from "vitest";

import { getVisibleNavItems, NAV_ITEMS } from "./nav";

describe("getVisibleNavItems", () => {
  it("shows every nav item, including Settings, to an Owner", () => {
    const items = getVisibleNavItems("OWNER");
    expect(items).toHaveLength(NAV_ITEMS.length);
    expect(items.some((item) => item.label === "Settings")).toBe(true);
  });

  it("hides Settings from Staff but keeps every other item", () => {
    const items = getVisibleNavItems("STAFF");
    expect(items.some((item) => item.label === "Settings")).toBe(false);
    expect(items).toHaveLength(NAV_ITEMS.length - 1);
    expect(items.map((item) => item.label)).toEqual([
      "Dashboard",
      "Accounting",
      "Diamond",
      "Jewellery Job",
      "Costing",
    ]);
  });
});
