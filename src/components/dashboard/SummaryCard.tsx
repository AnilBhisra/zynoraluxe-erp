import { Card, CardHeader } from "@/components/ui/Card";
import { PhaseBadge } from "@/components/ui/PhaseNotice";

export function SummaryCard({
  label,
  unit,
  phase,
}: {
  label: string;
  unit?: string;
  phase: number;
}) {
  return (
    <Card>
      <CardHeader className="p-4 sm:p-5">
        <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">{label}</p>
        <p className="mt-2 flex items-baseline gap-1.5">
          <span className="text-2xl font-semibold tracking-tight text-zinc-400 dark:text-zinc-600">
            —
          </span>
          {unit ? (
            <span className="text-xs text-zinc-400 dark:text-zinc-600">{unit}</span>
          ) : null}
        </p>
        <div className="mt-3">
          <PhaseBadge phase={phase} />
        </div>
      </CardHeader>
    </Card>
  );
}
