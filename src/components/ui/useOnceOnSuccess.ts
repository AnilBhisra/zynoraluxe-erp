"use client";

import { useEffect, useRef } from "react";

/**
 * Calls `callback` exactly once for each NEW successful action result. The
 * callback is read through a ref, so a parent passing a fresh function on
 * every render (e.g. `() => router.refresh()`) can never re-trigger it — the
 * refresh loop this prevents is described in PAYMENT_BALANCE_AUDIT.md.
 */
export function useOnceOnSuccess<S extends { success?: boolean | string } | undefined | null>(state: S, callback: () => void) {
  const handled = useRef<S | undefined>(undefined);
  const cb = useRef(callback);
  useEffect(() => {
    cb.current = callback;
  });
  useEffect(() => {
    if (!state || !state.success || handled.current === state) return;
    handled.current = state;
    cb.current();
  }, [state]);
}
