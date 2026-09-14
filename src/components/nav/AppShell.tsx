"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import type { NavItem } from "@/lib/nav";
import type { CurrentUser } from "@/lib/auth/dal";
import { logout } from "@/app/actions/auth";
import { Button } from "@/components/ui/Button";
import { NAV_ICONS, MenuIcon, CloseIcon, LogoutIcon } from "@/components/nav/icons";

function isActivePath(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavList({
  items,
  pathname,
  onNavigate,
}: {
  items: NavItem[];
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="Main" className="flex flex-1 flex-col gap-1 px-3">
      {items.map((item) => {
        const Icon = NAV_ICONS[item.href];
        const active = isActivePath(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:focus-visible:ring-amber-300 ${
              active
                ? "bg-zinc-900 text-white dark:bg-amber-200 dark:text-zinc-900"
                : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            }`}
          >
            {Icon ? <Icon className="h-5 w-5 shrink-0" /> : null}
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function BrandMark() {
  return (
    <div className="flex items-center gap-2 px-2">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-900 text-sm font-bold tracking-wide text-amber-200 dark:bg-amber-200 dark:text-zinc-900">
        Z
      </span>
      <span className="text-sm font-semibold tracking-[0.12em] text-zinc-900 uppercase dark:text-zinc-50">
        Zynoraluxe
      </span>
    </div>
  );
}

function UserFooter({ user }: { user: CurrentUser }) {
  return (
    <div className="border-t border-[var(--border)] p-3">
      <div className="mb-2 flex items-center gap-3 rounded-lg px-2 py-2">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-sm font-semibold text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">
          {user.name.charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
            {user.name}
          </span>
          <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">
            {user.role === "OWNER" ? "Owner" : "Staff"}
          </span>
        </span>
      </div>
      <form action={logout}>
        <Button
          type="submit"
          variant="ghost"
          className="w-full justify-start text-zinc-600 dark:text-zinc-400"
        >
          <LogoutIcon className="h-5 w-5" />
          Log out
        </Button>
      </form>
    </div>
  );
}

export function AppShell({
  user,
  items,
  children,
}: {
  user: CurrentUser;
  items: NavItem[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (menuOpen) {
      closeButtonRef.current?.focus();
    } else {
      openButtonRef.current?.focus();
    }
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      {/* Desktop sidebar */}
      <aside
        data-print-hide="true"
        className="hidden w-64 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] py-4 lg:flex"
      >
        <div className="mb-6">
          <BrandMark />
        </div>
        <NavList items={items} pathname={pathname} />
        <UserFooter user={user} />
      </aside>

      {/* Mobile top bar */}
      <header
        data-print-hide="true"
        className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3 lg:hidden"
      >
        <BrandMark />
        <button
          ref={openButtonRef}
          type="button"
          aria-label="Open menu"
          aria-expanded={menuOpen}
          aria-controls="mobile-nav-drawer"
          onClick={() => setMenuOpen(true)}
          className="flex h-11 w-11 items-center justify-center rounded-lg text-zinc-700 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:focus-visible:ring-amber-300"
        >
          <MenuIcon className="h-6 w-6" />
        </button>
      </header>

      {/* Mobile drawer */}
      {menuOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-black/40"
            onClick={() => setMenuOpen(false)}
          />
          <div
            id="mobile-nav-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Main navigation"
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-[var(--surface)] py-4 shadow-xl"
          >
            <div className="mb-6 flex items-center justify-between px-2">
              <BrandMark />
              <button
                ref={closeButtonRef}
                type="button"
                aria-label="Close menu"
                onClick={() => setMenuOpen(false)}
                className="flex h-10 w-10 items-center justify-center rounded-lg text-zinc-700 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                <CloseIcon className="h-5 w-5" />
              </button>
            </div>
            <NavList items={items} pathname={pathname} onNavigate={() => setMenuOpen(false)} />
            <UserFooter user={user} />
          </div>
        </div>
      ) : null}

      <main className="flex-1 px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
