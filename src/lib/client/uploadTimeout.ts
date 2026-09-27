/**
 * Generic, non-storage-security timeout helper shared by every photo
 * upload field (Jewellery, Diamond, Costing). Deliberately NOT merged into
 * src/lib/storage/*Media.ts — those stay duplicated per module on purpose
 * (see their own doc comments) because they carry security-sensitive
 * logic. This file carries none: it is a plain bounded-wait wrapper around
 * a promise, so sharing it across the three thin Client Components below
 * doesn't touch that policy.
 *
 * Root cause this exists for: calling a "use server" action directly from
 * a Client Component (not via `<form action>`) returns a bare promise with
 * no built-in timeout — Node's own `fetch`, which the action eventually
 * calls into (see uploadJewelleryAsset/uploadDiamondAsset), has no default
 * timeout either. On a slow/flaky connection (reported specifically on a
 * "laptop", not the faster "desktop" the same image uploaded fine from)
 * that promise can simply never settle, leaving a Client Component's own
 * `pending` state stuck forever with no error — exactly the reported
 * symptom. `withClientTimeout` bounds every upload attempt so the UI is
 * guaranteed to recover, and pairs with a per-attempt "generation" counter
 * in each caller so a late-arriving result from an already-abandoned
 * attempt never clobbers a newer one's state.
 */

export class ClientTimeoutError extends Error {}

/** Total time the UI waits for one upload attempt (select-photo to
 * success-or-error) before giving up client-side and showing a retry-safe
 * timeout message. Deliberately longer than either storage module's own
 * server-side fetch timeout (30s upload / 10s metadata call — see
 * src/lib/storage/*Media.ts) so the server's own clean, specific error
 * normally arrives and is shown first; this is the last-resort backstop
 * for when the client-to-server leg itself is what's hanging. */
export const UPLOAD_CLIENT_TIMEOUT_MS = 45_000;

/**
 * Races `promise` against a timer. If the timer fires first, rejects with
 * `ClientTimeoutError` — the original promise is simply abandoned (left to
 * settle in the background); callers ignore its eventual result via their
 * own per-attempt generation check rather than this helper cancelling
 * anything (a Server Action call has no cancellation hook available here).
 */
export function withClientTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ClientTimeoutError(timeoutMessage)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
