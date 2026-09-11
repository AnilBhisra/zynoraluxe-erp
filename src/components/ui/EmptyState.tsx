export function EmptyState({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-zinc-300 bg-zinc-50/60 px-6 py-14 text-center dark:border-zinc-700 dark:bg-zinc-900/40">
      {icon ? (
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-zinc-400 shadow-sm dark:bg-zinc-800 dark:text-zinc-500">
          {icon}
        </div>
      ) : null}
      <div>
        <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{title}</p>
        {description ? (
          <p className="mt-1 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
