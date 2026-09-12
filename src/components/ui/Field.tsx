"use client";

import { cloneElement, isValidElement } from "react";

import { cn } from "@/lib/utils/cn";
import { useFieldId } from "@/lib/utils/useFieldId";

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
  /** Opt out of the auto-generated id (e.g. a caller that needs a
   * specific, stable id) — otherwise one unique to this component
   * instance is generated, so two forms both having a field named e.g.
   * "email" mounted on the same page never collide. */
  id?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children?: React.ReactNode;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "name" | "id">;

export function Field({
  label,
  name,
  id: idProp,
  error,
  hint,
  required,
  className,
  children,
  ...inputProps
}: FieldProps) {
  const id = useFieldId(idProp);
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null]
    .filter(Boolean)
    .join(" ") || undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
        {label}
        {required ? <span className="text-red-600 dark:text-red-400"> *</span> : null}
      </label>
      {children ? (
        // A caller passing a custom control (e.g. a <select>) as children
        // is responsible for its own `name`, but its `id` is force-matched
        // to this label's `htmlFor` here — regardless of whatever id the
        // caller's JSX happens to write on it — so `<Field><select
        // id="anything" .../></Field>` can never drift out of sync with
        // the generated label id (a real class of bug this fix closes:
        // before, both independently hardcoded the same field `name` as
        // their id, which happened to line up only by coincidence and broke
        // the moment two same-named fields from different forms ever
        // shared a page).
        isValidElement(children)
          ? cloneElement(children as React.ReactElement<{ id?: string }>, { id })
          : children
      ) : (
        <input
          id={id}
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
