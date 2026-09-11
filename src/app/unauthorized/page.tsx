import type { Metadata } from "next";
import Link from "next/link";

import { buttonClasses } from "@/components/ui/Button";

export const metadata: Metadata = {
  title: "Not available · ZYNORALUXE",
};

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
