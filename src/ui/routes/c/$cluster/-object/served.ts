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
  const entry = catalog.entries.find(
    (e) => e.group === group && e.plural === plural
  );
  if (entry) return { state: "served", entry };
  const unread = catalog.unread.find((g) => g.group === group);
  return unread
    ? { state: "unknown", error: unread.message }
    : { state: "absent" };
}

/** A minute: a kind appears when something is installed, not mid-read. */
const CATALOG_STALE_MS = 60_000;

export function useServed(resource: ServedResource): Served {
  const isConnected = useClusterStore((state) => state.isConnected);
  const catalog = useQuery({
    queryKey: queryKeys.apiCatalog(),
    queryFn: () => commands.listApiCatalog(),
    enabled: isConnected,
    staleTime: CATALOG_STALE_MS,
    retry: false,
  });
  return servedIn(catalog.data, catalog.error, resource);
}
