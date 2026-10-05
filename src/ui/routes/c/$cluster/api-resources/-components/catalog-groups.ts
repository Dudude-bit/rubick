import type { ApiCatalog, CatalogEntry, UnreadGroup } from "@/generated/types";

export interface CatalogGroup {
  group: string;
  entries: CatalogEntry[];
}

export interface FilteredCatalog {
  groups: CatalogGroup[];
  /** Groups discovery did not answer for: their kinds could match anything. */
  unread: UnreadGroup[];
  kinds: number;
}

const matches = (entry: CatalogEntry, needle: string) =>
  [entry.kind, entry.plural, entry.group, `${entry.plural}.${entry.group}`]
    .join(" ")
    .toLowerCase()
    .includes(needle);

/** The catalogue grouped by API group, core first, narrowed by a filter. */
export function catalogGroups(
  catalog: ApiCatalog,
  filter: string
): FilteredCatalog {
  const needle = filter.trim().toLowerCase();
  const byGroup = new Map<string, CatalogEntry[]>();
  for (const entry of catalog.entries) {
    if (needle && !matches(entry, needle)) continue;
    byGroup.set(entry.group, [...(byGroup.get(entry.group) ?? []), entry]);
  }
  const groups = [...byGroup.entries()]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([group, entries]) => ({
      group,
      entries: entries.sort((a, b) => a.kind.localeCompare(b.kind)),
    }));
  return {
    groups,
    unread: [...catalog.unread].sort((a, b) => a.group.localeCompare(b.group)),
    kinds: groups.reduce((sum, group) => sum + group.entries.length, 0),
  };
}

export const listable = (entry: CatalogEntry) => entry.verbs.includes("list");
