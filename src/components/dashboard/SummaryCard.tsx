import { Card, CardHeader } from "@/components/ui/Card";
import { PhaseBadge } from "@/components/ui/PhaseNotice";

type SummaryCardProps =
  | { label: string; unit?: string; phase: number; value?: undefined }
  | { label: string; unit?: string; phase?: undefined; value: string };

export function SummaryCard(props: SummaryCardProps) {
  const { label, unit } = props;
  const isLive = props.value !== undefined;

  return (
    <Card>
      <CardHeader className="p-4 sm:p-5">
        <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">{label}</p>
        <p className="mt-2 flex items-baseline gap-1.5">
          <span
            className={
              isLive
                ? "text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50"
                : "text-2xl font-semibold tracking-tight text-zinc-400 dark:text-zinc-600"
            }
          >
            {isLive ? props.value : "—"}
          </span>
          {unit ? <span className="text-xs text-zinc-400 dark:text-zinc-600">{unit}</span> : null}
        </p>
        <div className="mt-3">
          {isLive ? (
            <span className="inline-flex items-center rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
              Live
            </span>
          ) : (
            <PhaseBadge phase={props.phase} />
          )}
        </div>
      </CardHeader>
    </Card>
  );
}
