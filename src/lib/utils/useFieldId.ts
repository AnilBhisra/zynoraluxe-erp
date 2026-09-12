import { useId } from "react";

/**
 * A stable, per-instance-unique id for a labelled form control. Backed by
 * React's `useId()`, so the same value is generated on the server render
 * and on client hydration (no mismatch), and is unique per component
 * instance even when two forms that both have, say, an "email" field are
 * mounted on the same page at once — unlike deriving an id straight from
 * the field's `name` (which collides across forms, producing invalid
 * duplicate `id`/`for` HTML and breaking `<label>`-click-to-focus for
 * whichever instance loses the collision).
 *
 * Pass an explicit `id` to opt out (e.g. a caller that must target a
 * specific, stable id for testing or deep-linking) — it is returned
 * unchanged.
 */
export function useFieldId(explicitId?: string): string {
  const generated = useId();
  return explicitId ?? generated;
}
