export type JobListFilters = { customerId: string; karigarId: string; goldSource: string };

/** The list URL with the given view and filters (empty values left out). */
export function jobListHref(view: string, f: Partial<JobListFilters> & { search?: string; jobId?: string }): string {
  const q = new URLSearchParams({ tab: "jobs", view });
  if (f.customerId) q.set("jobCustomer", f.customerId);
  if (f.karigarId) q.set("jobKarigar", f.karigarId);
  if (f.goldSource) q.set("goldSource", f.goldSource);
  if (f.search) q.set("jobSearch", f.search);
  if (f.jobId) q.set("jobId", f.jobId);
  return `/jewellery-jobs?${q.toString()}`;
}
