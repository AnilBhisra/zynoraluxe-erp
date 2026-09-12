export type NavItem = {
  label: string;
  href: string;
  ownerOnly?: boolean;
};

export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Accounting", href: "/accounting" },
  { label: "Diamond", href: "/diamond" },
  { label: "Jewellery Job", href: "/jewellery-jobs" },
  { label: "Costing", href: "/costing", ownerOnly: true },
  { label: "Settings", href: "/settings", ownerOnly: true },
];

export function getVisibleNavItems(role: "OWNER" | "STAFF"): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.ownerOnly || role === "OWNER");
}
