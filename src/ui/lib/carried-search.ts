import { getResourceListUrl, RESOURCE_REGISTRY } from "@/lib/resource-registry";

/**
 * The list search, carried from one kind to the next.
 *
 * The search belongs to the reader's question, not to the kind: a release's
 * name is part of its pods, its deployments and its configmaps alike, and
 * walking between those lists to follow one name meant typing it again at
 * every stop. The address is still the authority — this only stops the
 * query string being dropped on the way.
 *
 * Only rows that list a kind. Settings and the Overview are not more of the
 * same question, and a search in their address would mean nothing. A list a
 * carried search empties still says which term emptied it and offers to
 * clear it, so this cannot leave somebody looking at a blank page.
 */
export function withCarriedSearch(
  path: string,
  kind: string | undefined,
  search: string,
  from: string
): string {
  if (!kind || !listsAKind(from)) return path;
  const term = new URLSearchParams(search).get("q");
  return term ? `${path}?q=${encodeURIComponent(term)}` : path;
}

/**
 * Whether `?q=` on this page means the list search at all. `q` is not
 * reserved — the Traefik page reads it as a hostname filter — so carrying is
 * gated at both ends. The set is the registry's own list routes, which is
 * where the sidebar's kind rows point.
 */
function listsAKind(pathname: string): boolean {
  return RESOURCE_REGISTRY.some(
    (entry) => getResourceListUrl(entry.kind) === pathname
  );
}
