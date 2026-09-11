import Link from "next/link";

type QuickActionButtonProps =
  | { label: string; href: string; phase: number; enabled?: undefined }
  | { label: string; href: string; phase?: undefined; enabled: true };

export function QuickActionButton(props: QuickActionButtonProps) {
  const { label, href } = props;
  return (
    <Link
      href={href}
      className="group flex flex-col gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-left transition-colors hover:border-zinc-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:hover:border-zinc-500 dark:focus-visible:ring-amber-300"
    >
      <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{label}</span>
      <span className="text-xs text-zinc-500 group-hover:text-zinc-600 dark:text-zinc-400">
        {props.enabled ? "Open a form to save this now" : `Available in Phase ${props.phase}`}
      </span>
    </Link>
  );
}
