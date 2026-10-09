import { useQuery } from "@tanstack/react-query";

import type { ApiCatalog, CatalogEntry } from "@/generated/types";
import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import { queryKeys } from "@/lib/query-keys";
import {
  getResourceDefinition,
  isResourceType,
  toKind,
} from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";

export interface ServedResource {
  group: string;
  plural: string;
}

/**
 * The group and plural an address names: `<plural>.<group>`, or a bare
 * plural, which is the registry's group where it knows the kind and the core
 * group where it does not, as kubectl reads it.
 */
export function servedOf(segment: string): ServedResource {
  const dot = segment.indexOf(".");
  if (dot !== -1)
    return { plural: segment.slice(0, dot), group: segment.slice(dot + 1) };
  const kind = isResourceType(segment) ? toKind(segment) : null;
  return {
    plural: segment,
    group: kind ? getResourceDefinition(kind).group : "",
  };
}

/** What the catalogue says about one kind: three answers, never two. */
export type Served =
  | { state: "reading" }
  | { state: "served"; entry: CatalogEntry }
  | { state: "absent" }
  | { state: "unknown"; error: string };

export function servedIn(
  catalog: ApiCatalog | undefined,
  failure: unknown,
  { group, plural }: ServedResource
): Served {
  if (failure) return { state: "unknown", error: errorToShow(failure) };
  if (!catalog) return { state: "reading" };
  // A bare plural the core group lacks is another group's, as kubectl reads
  // it: `clusterroles` is rbac.authorization.k8s.io's, not a missing kind.
  const entry =
    catalog.entries.find((e) => e.group === group && e.plural === plural) ??
    (group === ""
      ? catalog.entries.find((e) => e.plural === plural)
      : undefined);
  if (entry) return { state: "served", entry };
  const unread = catalog.unread.find((g) => g.group === group);
  return unread
    ? { state: "unknown", error: unread.message }
    : { state: "absent" };
}

/**
 * Whether an address segment names a namespaced kind: the registry's word
 * for its own kinds, discovery's for the rest, `null` while discovery has
 * not answered.
 */
export function segmentNamespaced(
  segment: string,
  served: Served
): boolean | null {
  if (isResourceType(segment))
    return getResourceDefinition(segment).scope !== "cluster";
  if (served.state === "served") return served.entry.namespaced;
  return served.state === "reading" ? null : false;
}

/** A minute: a kind appears when something is installed, not mid-read. */
const CATALOG_STALE_MS = 60_000;

/** The catalogue's one cache entry, for a hook and for a read inside a query. */
export const catalogQuery = () => ({
  queryKey: queryKeys.apiCatalog(),
  queryFn: () => commands.listApiCatalog(),
  staleTime: CATALOG_STALE_MS,
  retry: false,
});

/**
 * What an address reads with: the served entry's group where discovery
 * resolved a bare plural, the address's own guess otherwise. `null` while a
 * bare plural the registry does not know waits for discovery, so the first
 * read is not a 404 from the core group.
 */
export function readTarget(
  segment: string,
  served: Served
): ServedResource | null {
  if (served.state === "served")
    return { group: served.entry.group, plural: served.entry.plural };
  const bare = !segment.includes(".") && !isResourceType(segment);
  return bare && served.state === "reading" ? null : servedOf(segment);
}

export function useServed(resource: ServedResource): Served {
  const isConnected = useClusterStore((state) => state.isConnected);
  const catalog = useQuery({ ...catalogQuery(), enabled: isConnected });
  return servedIn(catalog.data, catalog.error, resource);
}
