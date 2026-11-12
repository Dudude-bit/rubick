import { narrowingHelps, toKind } from "@/lib/resource-registry";

/** The cluster's own pages that read the window's namespaces, beside the lists of namespaced kinds. */
const SCOPED_PAGES = new Set(["", "events", "changes", "helm"]);

/**
 * Whether the page at `pathname` draws what the window's namespaces hold: the
 * Overview, Events, Changes, Helm and every list of a namespaced kind. An
 * object's own page names its namespace in the address and reads that one.
 */
export function readsScope(pathname: string): boolean {
  const [, , page = "", ...rest] = pathname.split("/").filter(Boolean);
  if (rest.length > 0) return false;
  if (SCOPED_PAGES.has(page)) return true;
  const kind = toKind(page);
  return kind !== null && narrowingHelps(kind);
}
