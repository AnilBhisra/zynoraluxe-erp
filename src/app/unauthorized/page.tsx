import type { Metadata } from "next";
import Link from "next/link";

import { buttonClasses } from "@/components/ui/Button";

export const metadata: Metadata = {
  title: "Not available · ZYNORALUXE",
};

// Forces per-request rendering. Without this, Next prerenders this page
// once at build time with no nonce baked into its script tags (there is
// no per-request nonce available at build time) — but src/proxy.ts still
// stamps a FRESH nonce onto every response's Content-Security-Policy
// header, including this one, so a statically-generated version of this
// page would carry a CSP that its own bundled scripts can never satisfy.
// Confirmed live: this exact mismatch reliably blocked this page's script
// chunks in a real production `next build`/`next start` run before this
// line was added.
export const dynamic = "force-dynamic";

export default function UnauthorizedPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-[var(--background)] px-4 py-12">
      <div className="w-full max-w-sm text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-red-100 text-2xl text-red-600 dark:bg-red-950/40 dark:text-red-400">
          !
        </span>
        <h1 className="mt-4 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          This page isn&apos;t available to your account
        </h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Settings and some controls are limited to the Owner. Ask your Owner if you need
          access.
        </p>
        <Link href="/dashboard" className={buttonClasses("primary", "md", "mt-6")}>
          Back to Dashboard
        </Link>
      </div>
    </div>
  );
}
