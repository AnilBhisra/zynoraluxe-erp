import { setStaffActive } from "@/app/actions/settings";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";

type StaffMember = {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
};

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
        <li
          key={member.id}
          className="flex flex-col gap-3 bg-[var(--surface)] p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
              {member.name}
            </p>
            <p className="truncate text-sm text-zinc-500 dark:text-zinc-400">{member.email}</p>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
                member.isActive
                  ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                  : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
              }`}
            >
              {member.isActive ? "Active" : "Inactive"}
            </span>
            <form action={setStaffActive}>
              <input type="hidden" name="userId" value={member.id} />
              <input type="hidden" name="nextActive" value={(!member.isActive).toString()} />
              <Button type="submit" variant="secondary" size="md">
                {member.isActive ? "Deactivate" : "Reactivate"}
              </Button>
            </form>
          </div>
        </li>
      ))}
    </ul>
  );
}
