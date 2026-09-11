import { requireUser } from "@/lib/auth/dal";
import { getVisibleNavItems } from "@/lib/nav";
import { AppShell } from "@/components/nav/AppShell";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const items = getVisibleNavItems(user.role);

  return (
    <AppShell user={user} items={items}>
      {children}
    </AppShell>
  );
}
