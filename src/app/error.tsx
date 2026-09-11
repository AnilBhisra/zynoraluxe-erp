"use client";

import { useEffect } from "react";

import { buttonClasses } from "@/components/ui/Button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[var(--background)] px-4 py-12">
      <div className="w-full max-w-sm text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-red-100 text-2xl text-red-600 dark:bg-red-950/40 dark:text-red-400">
          !
        </span>
        <h1 className="mt-4 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          Something went wrong
        </h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Please try again. If this keeps happening, check that the database connection is
          configured correctly.
        </p>
        <button type="button" onClick={() => reset()} className={buttonClasses("primary", "md", "mt-6")}>
          Try again
        </button>
      </div>
    </div>
  );
}
