import { cn } from "@/lib/utils/cn";

const INPUT_BASE =
  "h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 placeholder:text-zinc-400 " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus:border-zinc-900 " +
  "disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-500 " +
  "dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus-visible:ring-amber-300 dark:focus:border-amber-300";

export function inputClasses(className?: string) {
  return cn(INPUT_BASE, className);
}

type FieldProps = {
  label: string;
  name: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children?: React.ReactNode;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "name">;

export function Field({
  label,
  name,
  error,
  hint,
  required,
  className,
  children,
  ...inputProps
}: FieldProps) {
  const errorId = `${name}-error`;
  const hintId = `${name}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null]
    .filter(Boolean)
    .join(" ") || undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={name} className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
        {label}
        {required ? <span className="text-red-600 dark:text-red-400"> *</span> : null}
      </label>
      {children ?? (
        <input
          id={name}
          name={name}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={inputClasses(className)}
          {...inputProps}
        />
      )}
      {hint && !error ? (
        <p id={hintId} className="text-xs text-zinc-500 dark:text-zinc-400">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
