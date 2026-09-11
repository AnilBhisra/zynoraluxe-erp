export function PhaseBadge({ phase }: { phase: number }) {
  return (
    <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
      Available in Phase {phase}
    </span>
  );
}

export function PhaseNotice({
  title,
  phase,
  summary,
}: {
  title: string;
  phase: number;
  summary: string;
}) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 sm:p-8">
      <PhaseBadge phase={phase} />
      <h2 className="mt-4 text-lg font-semibold text-zinc-900 dark:text-zinc-50">{title}</h2>
      <p className="mt-2 max-w-xl text-sm leading-6 text-zinc-600 dark:text-zinc-400">
        {summary}
      </p>
      <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-500">
        This screen is a route foundation. No transactions, stock or costing data can be
        created here yet.
      </p>
    </div>
  );
}
