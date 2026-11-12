import type { ListAccess, ListQuery } from "@/generated/types";

/**
 * `checkListAccess` as the backend answers it: one answer per question, in
 * the order asked. A plural the table does not name could not be asked about.
 */
export const listAccessOf =
  (table: Record<string, boolean | null>) =>
  async (queries: ListQuery[]): Promise<ListAccess[]> =>
    queries.map((query) => ({
      resource: query.resource,
      allowed: table[query.resource] ?? null,
    }));
