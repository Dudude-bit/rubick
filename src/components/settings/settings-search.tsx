import * as React from "react";

/**
 * Search over settings, filtering rows rather than sections.
 *
 * A setting you were told about once is a name you half-remember, not a
 * category you can place. Dimming the sections that hold nothing and
 * counting what matched in the one you are looking at turns five scrolls
 * into one keystroke.
 *
 * Two consequences shape the whole mechanism:
 *
 * 1. A row that does not match is hidden, never unmounted. An unmounted
 *    row deregisters, the count it contributed disappears, and a query
 *    that would bring it back can no longer see it — the section it lives
 *    in would go quiet and stay quiet.
 * 2. Rows index themselves from what they already render, so the index is
 *    the screen rather than a second list of labels that drifts from it.
 */

interface Entry {
  sectionId: string;
  groupId: string | null;
  text: string;
}

interface SearchValue {
  query: string;
  setQuery: (query: string) => void;
  terms: string[];
  /** Matching rows per section id. Empty while there is no query. */
  counts: Record<string, number>;
  register: (id: string, entry: Entry) => void;
  unregister: (id: string) => void;
  entries: ReadonlyMap<string, Entry>;
}

const SearchContext = React.createContext<SearchValue | null>(null);
const SectionContext = React.createContext<string | null>(null);
const GroupContext = React.createContext<string | null>(null);

/** Terms are ANDed, so "helm path" finds the row that is both. */
function hits(text: string, terms: string[]): boolean {
  return terms.every((term) => text.includes(term));
}

function toTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * The words a reader would point at.
 *
 * A hint is often an element — a mono path, a coloured failure — and the
 * words inside it are the ones somebody actually remembers ("homebrew",
 * "$KUBECONFIG"). Walking the node reaches them. It stops at a component
 * boundary, which is what the `keywords` prop is for.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function nodeText(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join(" ");
  if (React.isValidElement(node)) {
    return nodeText((node.props as { children?: React.ReactNode }).children);
  }
  return "";
}

export function SettingsSearchProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [query, setQuery] = React.useState("");
  const [entries, setEntries] = React.useState<ReadonlyMap<string, Entry>>(
    () => new Map()
  );

  const register = React.useCallback((id: string, entry: Entry) => {
    setEntries((prev) => {
      const held = prev.get(id);
      if (
        held &&
        held.text === entry.text &&
        held.sectionId === entry.sectionId &&
        held.groupId === entry.groupId
      ) {
        return prev;
      }
      const next = new Map(prev);
      next.set(id, entry);
      return next;
    });
  }, []);

  const unregister = React.useCallback((id: string) => {
    setEntries((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const terms = React.useMemo(() => toTerms(query), [query]);

  const counts = React.useMemo(() => {
    const tally: Record<string, number> = {};
    if (terms.length === 0) return tally;
    entries.forEach(({ sectionId, text }) => {
      if (hits(text, terms)) {
        tally[sectionId] = (tally[sectionId] ?? 0) + 1;
      }
    });
    return tally;
  }, [entries, terms]);

  const value = React.useMemo(
    () => ({ query, setQuery, terms, counts, register, unregister, entries }),
    [query, terms, counts, register, unregister, entries]
  );

  return (
    <SearchContext.Provider value={value}>{children}</SearchContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSettingsSearch(): SearchValue {
  const value = React.useContext(SearchContext);
  if (!value) {
    throw new Error("useSettingsSearch must be used inside the settings shell");
  }
  return value;
}

/** Names the section a row belongs to, so its match can be counted. */
export function SettingsSectionScope({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  return (
    <SectionContext.Provider value={id}>{children}</SectionContext.Provider>
  );
}

export function SettingsGroupScope({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  return <GroupContext.Provider value={id}>{children}</GroupContext.Provider>;
}

/**
 * Indexes one row and answers whether the query keeps it on screen.
 *
 * Outside the settings shell there is no provider and every row is
 * visible, which is what lets the same primitives be used in a dialog.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useSettingSearchMatch(...parts: React.ReactNode[]): boolean {
  const search = React.useContext(SearchContext);
  const sectionId = React.useContext(SectionContext);
  const groupId = React.useContext(GroupContext);
  const id = React.useId();

  const text = parts.map(nodeText).join(" ").toLowerCase();
  const register = search?.register;
  const unregister = search?.unregister;

  React.useEffect(() => {
    if (!register || !sectionId) return;
    register(id, { sectionId, groupId, text });
  }, [register, id, sectionId, groupId, text]);

  React.useEffect(() => {
    if (!unregister) return;
    return () => unregister(id);
  }, [unregister, id]);

  if (!search || search.terms.length === 0) return true;
  return hits(text, search.terms);
}

/** Whether any indexed row inside this group survives the query. */
// eslint-disable-next-line react-refresh/only-export-components
export function useGroupHasMatch(groupId: string): boolean {
  const search = React.useContext(SearchContext);
  if (!search || search.terms.length === 0) return true;
  for (const entry of search.entries.values()) {
    if (entry.groupId === groupId && hits(entry.text, search.terms))
      return true;
  }
  return false;
}
