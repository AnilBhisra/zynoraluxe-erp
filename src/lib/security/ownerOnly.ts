/**
 * Server-side redaction for data shaped into Client Component props.
 *
 * Hiding a figure inside a Client Component (`isOwner ? … : null`) is not a
 * security boundary: every prop is serialized into the page's RSC payload
 * and reaches the browser regardless of what the component renders. Cost,
 * carrying value, payable and profit figures must therefore be dropped on
 * the server before the object ever crosses into a Client Component — see
 * node_modules/next/dist/docs/01-app/02-guides/data-security.md.
 */
export function ownerOnly<T>(isOwner: boolean, value: T): T | null {
  return isOwner ? value : null;
}
