"use client";

import { useActionState, useState } from "react";

import { resetStaffPassword, setStaffActive } from "@/app/actions/settings";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { inputClasses } from "@/components/ui/Field";

type StaffMember = {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
};

function StaffRow({ member }: { member: StaffMember }) {
  const [isResetting, setIsResetting] = useState(false);
  const [state, formAction, isPending] = useActionState(resetStaffPassword, undefined);

  return (
    <li className="flex flex-col gap-3 bg-[var(--surface)] p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
            {member.name}
          </p>
          <p className="truncate text-sm text-zinc-500 dark:text-zinc-400">{member.email}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
              member.isActive
                ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
            }`}
          >
            {member.isActive ? "Active" : "Inactive"}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="md"
            onClick={() => setIsResetting(!isResetting)}
          >
            {isResetting ? "Cancel Reset" : "Reset Password"}
          </Button>
          <form action={setStaffActive}>
            <input type="hidden" name="userId" value={member.id} />
            <input type="hidden" name="nextActive" value={(!member.isActive).toString()} />
            <Button type="submit" variant="secondary" size="md">
              {member.isActive ? "Deactivate" : "Reactivate"}
            </Button>
          </form>
        </div>
      </div>

      {isResetting && (
        <form
          action={async (formData) => {
            await formAction(formData);
          }}
          className="mt-2 flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-zinc-50 p-3 dark:bg-zinc-900/50"
        >
          <input type="hidden" name="userId" value={member.id} />
          {state?.error && (
            <p className="text-xs text-red-600 dark:text-red-400">{state.error}</p>
          )}
          {state?.success && (
            <p className="text-xs text-emerald-600 dark:text-emerald-400">
              Password updated successfully!
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              type="password"
              name="newPassword"
              placeholder="Enter new password (min 8 characters)"
              required
              minLength={8}
              className={inputClasses("flex-1")}
            />
            <Button type="submit" variant="primary" size="md" disabled={isPending}>
              {isPending ? "Updating..." : "Save New Password"}
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}

export function StaffList({ staff }: { staff: StaffMember[] }) {
  if (staff.length === 0) {
    return (
      <EmptyState
        title="No Staff accounts yet"
        description="Staff accounts you create will appear here."
      />
    );
  }

  return (
    <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)]">
      {staff.map((member) => (
        <StaffRow key={member.id} member={member} />
      ))}
    </ul>
  );
}
