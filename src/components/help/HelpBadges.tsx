const BASE = "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium";

/** Staff can perform this action themselves. */
export function StaffCanBadge() {
  return (
    <span className={`${BASE} border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300`}>
      Staff કરી શકે
    </span>
  );
}

/** Owner-only action or screen. */
export function OwnerOnlyBadge() {
  return (
    <span className={`${BASE} border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300`}>
      ફક્ત Owner
    </span>
  );
}

/** A step that needs extra care — cannot be undone, or affects real money/stock. */
export function CautionBadge() {
  return (
    <span className={`${BASE} border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300`}>
      સાવધાની
    </span>
  );
}

/** Reminds the employee to double-check a field before pressing Save. */
export function CheckBeforeSaveBadge() {
  return (
    <span className={`${BASE} border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300`}>
      Save કરતાં પહેલાં ચેક કરો
    </span>
  );
}
