/**
 * The Owner-facing message shown instead of a number when a posted
 * revaluation touches a record but its ledger could not be replayed —
 * never an approximation. Deliberately NOT "server-only": both the server
 * read model (carryingCost.ts) and the client components that render this
 * exact string need it, so it lives in its own tiny, client-safe file.
 */
export const CARRYING_COST_UNAVAILABLE_MESSAGE = "Current cost unavailable — reconciliation required";
