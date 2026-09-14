import Link from "next/link";

/** Small, unobtrusive link to the relevant anchored section of the Help
 * page — placed in a module page's PageHeader `actions` slot. Never
 * redesigns or clutters the page it sits on. */
export function HelpLink({ anchor }: { anchor: string }) {
  return (
    <Link
      href={`/help#${anchor}`}
      className="inline-flex h-11 items-center gap-1.5 rounded-lg border border-zinc-300 px-4 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
    >
      <span aria-hidden="true">?</span>
      મદદ
    </Link>
  );
}
