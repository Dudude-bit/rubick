import type { ReactNode } from "react";
import {
  Activity,
  Box,
  FileText,
  LayoutDashboard,
  Library,
  Network,
  Package,
  Server,
  Settings,
  ShieldUser,
  Terminal,
} from "lucide-react";

import type { ActivityTab } from "@/stores/activityPanelStore";
import {
  MIN_SEARCH_LENGTH,
  isSearchable,
  type ClusterSearchState,
  type SearchHit,
} from "./useResourceSearch";
import {
  matchesAllClusters,
  parseBang,
  rankContexts,
} from "@/lib/cluster-search";
import {
  clusterLink,
  listLink,
  objectLink,
  pageLink,
  servedListLink,
  servedObjectLink,
  type AppLink,
} from "@/lib/links";
import { isResourceType, ResourceType, toKind } from "@/lib/resource-registry";
import { aliasOf, type ClusterMark } from "@/stores/clusterIdentityStore";
import type { CatalogEntry, RecentItem } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { en } from "@/i18n/catalogue";
import { highlight } from "./palette-highlight";
import { translate } from "@/i18n";
import { shortNamesOf } from "@/lib/kind-aliases";
import {
  actionMatches,
  paletteActionsOf,
  type ActionsReport,
  type ActionTarget,
  type PaletteAction,
} from "./palette-actions";

type Words = keyof typeof en.paletteWords;

const quickActions: Array<{
  icon: IconType;
  label: keyof typeof en.action;
  words: Words;
  path: AppLink;
}> = [
  {
    icon: LayoutDashboard,
    label: "goToOverview",
    words: "overview",
    path: clusterLink(),
  },
  {
    icon: Box,
    label: "goToPods",
    words: "Pod",
    path: listLink(ResourceType.Pod),
  },
  {
    icon: Box,
    label: "goToDeployments",
    words: "Deployment",
    path: listLink(ResourceType.Deployment),
  },
  {
    icon: Network,
    label: "goToServices",
    words: "Service",
    path: listLink(ResourceType.Service),
  },
  {
    icon: Server,
    label: "goToNodes",
    words: "Node",
    path: listLink(ResourceType.Node),
  },
  {
    icon: FileText,
    label: "goToConfigMaps",
    words: "ConfigMap",
    path: listLink(ResourceType.ConfigMap),
  },
  {
    icon: FileText,
    label: "goToSecrets",
    words: "Secret",
    path: listLink(ResourceType.Secret),
  },
  {
    icon: Activity,
    label: "goToEvents",
    words: "events",
    path: pageLink("events"),
  },
  { icon: Package, label: "goToHelm", words: "helm", path: pageLink("helm") },
  {
    icon: Library,
    label: "goToApiResources",
    words: "apiResources",
    path: pageLink("api-resources"),
  },
  { icon: ShieldUser, label: "goToMyAccess", path: pageLink("my-access") },
];

export const english: T = (section, key, values) =>
  translate("en", section, key, values);

/** The words a page or kind is found by besides its title, in both languages. */
export function wordsOf(key: string, t: T): string[] {
  if (!(key in en.paletteWords)) return [];
  const words = key as Words;
  return [t("paletteWords", words), english("paletteWords", words)]
    .flatMap((list) => list.split(","))
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);
}

/** A page row's title in the reader's language or in English, or one of its words. */
function titleMatches(
  titles: readonly string[],
  words: readonly string[],
  needle: string
): boolean {
  return [...titles, ...words].some((title) =>
    title.toLowerCase().includes(needle)
  );
}

/** Kinds a query offers to open the list of, before any object it finds. */
export const KINDS_SHOWN = 6;

/**
 * Kinds the query names: by kind, plural, kubectl short name, or a word the
 * reader's language or English calls it. Whole names first, then prefixes.
 */
export function matchingKinds(
  kinds: readonly CatalogEntry[],
  query: string,
  wordsFor: (kind: string) => readonly string[] = () => []
): CatalogEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const rank = (entry: CatalogEntry) => {
    const names = [entry.kind.toLowerCase(), entry.plural.toLowerCase()];
    const words = wordsFor(entry.kind);
    if (
      [...names, ...words].includes(needle) ||
      shortNamesOf(entry).includes(needle)
    )
      return 0;
    if ([...names, ...words].some((name) => name.startsWith(needle))) return 1;
    if ([...names, ...words].some((name) => name.includes(needle))) return 2;
    return null;
  };
  return kinds
    .flatMap((entry) => {
      const at = rank(entry);
      return at === null ? [] : [{ entry, at }];
    })
    .sort(
      (a, b) =>
        a.at - b.at ||
        a.entry.kind.localeCompare(b.entry.kind) ||
        a.entry.group.localeCompare(b.entry.group)
    )
    .slice(0, KINDS_SHOWN)
    .map(({ entry }) => entry);
}

/**
 * The Activity panel's tabs, by the names a reader searches for.
 *
 * The panel is a sheet behind a status-bar line, so a reader with a port
 * forward running has no other way to reach it.
 */
const PANELS: Array<{
  tab: ActivityTab;
  label: keyof typeof en.activity;
  icon: IconType;
}> = [
  { tab: "ports", label: "panelPortForwards", icon: Network },
  { tab: "terminals", label: "terminals", icon: Terminal },
];

/**
 * Rows one cluster may spend while others are still answering.
 *
 * Twenty hits from one cluster would push every other cluster's line below
 * the fold, including the failed one and the one still connecting. The rest
 * of that cluster's hits are one keystroke away on its own row.
 */
export const ROWS_PER_CLUSTER = 5;

/**
 * Which clusters the query runs against.
 *
 * `current` is the default: every keystroke would otherwise wake every
 * connection in the kubeconfig. The other two are reached by typing `!`, and
 * both are visible afterwards as a chip.
 */
export type Scope =
  | { kind: "current" }
  | { kind: "all" }
  | { kind: "context"; context: string };

/** One rendered line. Only some of them are places the arrows stop. */
export type Entry =
  | { id: string; kind: "caption"; text: ReactNode }
  | { id: string; kind: "hint"; text: ReactNode; tone?: HintTone }
  | {
      id: string;
      kind: "cluster";
      context: string;
      /** What it is called. The context name when it is called nothing else. */
      label: ReactNode;
      /** The context name, on a second line, when the first one is not it. */
      sub?: ReactNode;
      hue?: number;
      meta: ReactNode;
    }
  | { id: string; kind: "all-clusters" }
  | {
      id: string;
      kind: "group";
      cluster: ClusterSearchState;
      action: GroupAction;
    }
  /** `path` is null for a hit that is a scope rather than a page: a Namespace. */
  | { id: string; kind: "hit"; hit: SearchHit; path: AppLink | null }
  | { id: string; kind: "more"; context: string; rest: number }
  | { id: string; kind: "link"; path: AppLink; label: string; icon: IconType }
  /** A kind the cluster serves; picking it opens its list. */
  | { id: string; kind: "kind"; entry: CatalogEntry; path: AppLink }
  /** What one cluster's name search read, and what it did not. */
  | {
      id: string;
      kind: "coverage";
      cluster: ClusterSearchState;
      /** The window's namespaces; null for a search of another cluster, which reads all of it. */
      scope: string | null;
      /** Served kinds left out; null where this cluster's catalogue was not read. */
      notSearched: CatalogEntry[] | null;
      /** API groups discovery did not answer, whose kinds nobody could name. */
      unreadGroups: number;
    }
  /** Reads every other kind the current cluster serves too. */
  | { id: string; kind: "search-more"; count: number }
  /** Opens the actions of the object the page on screen is about. */
  | { id: string; kind: "page-actions"; target: ActionTarget }
  /** Whose actions the list is showing. */
  | { id: string; kind: "target"; target: ActionTarget }
  | { id: string; kind: "action"; target: ActionTarget; action: PaletteAction }
  /** A row that does something instead of going somewhere. See `PANELS`. */
  | {
      id: string;
      kind: "panel";
      tab: ActivityTab;
      label: string;
      icon: IconType;
    }
  /** Settings is a layer too, and the one every screen has to be able to reach. */
  | { id: string; kind: "settings"; label: string; icon: IconType }
  | {
      id: string;
      kind: "recent";
      path: AppLink;
      name: string;
      resourceKind: string;
      namespace?: string;
      context: string;
      crd?: string;
    };

export type IconType = React.ComponentType<{ className?: string }>;

/** What an empty result is: still coming, partly unread, or read and empty. */
export type HintTone = "loading" | "unread" | "empty";

/** What Enter does on a cluster's own row, when it does anything. */
export type GroupAction = "none" | "search-it" | "retry";

/** A hit that names a scope instead of an object the router can open. */
function isNamespaceHit(hit: SearchHit): boolean {
  return (
    hit.group === "" &&
    isResourceType(hit.kind) &&
    toKind(hit.kind) === ResourceType.Namespace
  );
}

/** One object among a cluster's hits; two groups may name a kind alike. */
export function hitKey(hit: SearchHit): string {
  const kind = hit.group ? `${hit.kind}.${hit.group}` : hit.kind;
  return `${kind}/${hit.namespace ?? ""}/${hit.name}`;
}

export function isSelectable(entry: Entry): boolean {
  if (
    entry.kind === "caption" ||
    entry.kind === "hint" ||
    entry.kind === "coverage" ||
    entry.kind === "target"
  )
    return false;
  if (entry.kind === "action")
    return !entry.action.reason && !entry.action.busy;
  if (entry.kind === "group") return entry.action !== "none";
  return true;
}

/** A cluster that has read at least something it can account for. */
function saidAnything(cluster: ClusterSearchState): boolean {
  return (
    cluster.status === "done" ||
    (cluster.status === "searching" &&
      cluster.searched.length + cluster.loading.length > 0)
  );
}

/** Listable kinds the cluster serves that this search compared no name of. */
export function notSearchedOf(
  kinds: readonly CatalogEntry[],
  cluster: ClusterSearchState
): CatalogEntry[] {
  const seen = new Set(
    [...cluster.searched, ...cluster.loading, ...cluster.unreadable].map(
      (kind) => `${kind.group}/${kind.plural}`
    )
  );
  return kinds.filter(
    (entry) =>
      entry.verbs.includes("list") &&
      !seen.has(`${entry.group}/${entry.plural}`)
  );
}

/**
 * What an empty result says, about objects and never about kinds: a kind row
 * above it may well have matched. It claims nothing it did not read. Still
 * answering is not empty, a refused or loading kind is named as such, and
 * "no object matches" names the kinds or clusters it covers.
 */
function emptyHint({
  query,
  clusters,
  working,
  answered,
  notSearched,
  t,
}: {
  query: string;
  clusters: ClusterSearchState[];
  working: boolean;
  answered: number;
  notSearched: number;
  t: T;
}): { text: ReactNode; tone: HintTone } {
  const total = clusters.length;
  const done = clusters.filter((cluster) => cluster.status === "done");
  const loading = new Set(
    clusters.flatMap((cluster) => cluster.loading.map((kind) => kind.kind))
  );
  if (working) {
    return {
      tone: "loading",
      text:
        total > 1
          ? t("empty", "noMatchesYet", { answered, total })
          : loading.size > 0
            ? t("count", "noObjectWhileLoading", { query, n: loading.size })
            : t("empty", "stillSearchingFor", { query }),
    };
  }
  if (done.length === 0) {
    return {
      tone: "unread",
      text: clusters.every(isCold)
        ? t("empty", "nothingSearchedNoCluster")
        : t("empty", "nothingSearchedAnywhere"),
    };
  }
  if (loading.size > 0) {
    return {
      tone: "loading",
      text: t("count", "noObjectWhileLoading", { query, n: loading.size }),
    };
  }
  const unread = [
    ...new Set(
      done.flatMap((cluster) => cluster.unreadable.map((kind) => kind.kind))
    ),
  ];
  if (unread.length > 0) {
    return {
      tone: "unread",
      text: t("empty", "nothingMatchesInReadable", {
        query,
        kinds: unread.join(", "),
      }),
    };
  }
  if (done.length < total) {
    return {
      tone: "unread",
      text: t("empty", "nothingMatchesOnSearched", {
        query,
        answered: done.length,
        total,
      }),
    };
  }
  if (total > 1) {
    return {
      tone: "empty",
      text: t("count", "noObjectOnClusters", { query, n: total }),
    };
  }
  const searched = t("count", "noObjectInKinds", {
    query,
    n: done[0].searched.length,
  });
  return {
    tone: "empty",
    text:
      notSearched > 0
        ? `${searched} ${t("count", "otherKindsWereNotSearched", { n: notSearched })}`
        : searched,
  };
}

export function isCold(cluster: ClusterSearchState): boolean {
  return cluster.status === "skipped" && cluster.reason === "not-connected";
}

/** Said its piece about this query. "Not connected" is not one of them. */
export function hasAnswered(cluster: ClusterSearchState): boolean {
  return cluster.status === "done" || cluster.status === "failed";
}

export interface PaletteState {
  /** The field as typed; a leading `!` picks a cluster instead. */
  text: string;
  scope: Scope;
  contexts: ReadonlyArray<{ name: string }>;
  currentContext: string | null;
  marks: Record<string, ClusterMark>;
  recentItems: RecentItem[];
  isConnected: boolean;
  error: string | null;
  /** Cluster rows in the order they were asked, cold ones included. */
  shownClusters: ClusterSearchState[];
  hitsByContext: Map<string, Map<string, SearchHit>>;
  /** What the current cluster serves, once read. */
  kinds?: readonly CatalogEntry[];
  /** API groups the current cluster's discovery did not answer. */
  unreadGroups?: number;
  /** The name search reads every kind the current cluster serves. */
  everything?: boolean;
  /** The window's namespaces, as the scope picker names them. */
  scopeLabel?: string;
  /** The object the page on screen is about, and its actions once read. */
  page?: PageActions;
  t: T;
}

export interface PageActions {
  target: ActionTarget;
  actions: PaletteAction[] | null;
  /** Each action's English words, matched in every language. */
  english: ReadonlyMap<string, string>;
}

export function buildPaletteEntries({
  text,
  scope,
  contexts,
  currentContext,
  marks,
  recentItems,
  isConnected,
  error,
  shownClusters,
  hitsByContext,
  kinds = [],
  unreadGroups = 0,
  everything = false,
  scopeLabel = "",
  page,
  t,
}: PaletteState): Entry[] {
  const bang = parseBang(text);
  const query = text.trim();
  const hasQuery = query.length > 0;
  const scoped = scope.kind !== "current";
  const answered = shownClusters.filter(hasAnswered).length;
  /** At least one cluster is still connecting or listing, right now. */
  const working = shownClusters.some(
    (cluster) =>
      cluster.status === "searching" || cluster.status === "connecting"
  );

  const out: Entry[] = [];

  if (bang) {
    out.push({
      id: "cap:clusters",
      kind: "caption",
      text: t("settings", "sectionClusters"),
    });
    if (matchesAllClusters(bang.needle)) {
      out.push({ id: "ctx:*", kind: "all-clusters" });
    }
    const ranked = rankContexts(
      bang.needle,
      contexts.map((ctx) => ctx.name),
      (context) => aliasOf(marks, context)
    );
    for (const match of ranked) {
      const alias = aliasOf(marks, match.context);
      out.push({
        id: `ctx:${match.context}`,
        kind: "cluster",
        context: match.context,
        hue: marks[match.context]?.hue,
        // Whichever of the two names the reader hit is the one that
        // carries the marks; the other one is still printed, because a
        // list you pick a cluster from cannot show only a nickname.
        label: alias && !match.viaAlias ? alias : highlight(match),
        sub: alias
          ? match.viaAlias
            ? match.context
            : highlight(match)
          : undefined,
        meta:
          match.context === currentContext
            ? t("cluster", "liveInline")
            : t("cluster", "notConnectedInline"),
      });
    }
    if (out.length === 1) {
      out.push({
        id: "hint:no-cluster",
        kind: "hint",
        // The ladder refuses a name it cannot justify rather than
        // offering the nearest one, so an empty list is a real answer.
        text: t("empty", "noClusterMatchesNeedle", {
          needle: bang.needle,
        }),
      });
    }
    return out;
  }

  if (!scoped && page) {
    if (!hasQuery) {
      out.push({
        id: "page-actions",
        kind: "page-actions",
        target: page.target,
      });
    } else {
      const matching = (page.actions ?? []).filter((action) =>
        actionMatches(action, page.english.get(action.id), query)
      );
      if (matching.length > 0) {
        out.push({
          id: "cap:page",
          kind: "caption",
          text: t("action", "paletteThisObject"),
        });
        for (const action of matching) {
          out.push({
            id: `act:${action.id}`,
            kind: "action",
            target: page.target,
            action,
          });
        }
      }
    }
  }

  if (!scoped) {
    // A recent saved before it named its cluster could open anywhere, so it
    // is not offered at all.
    const recent = recentItems.flatMap((item) => {
      const { context } = item;
      if (!context) return [];
      const path = objectLink(item, { cluster: context });
      return path ? [{ item, context, path }] : [];
    });
    if (!hasQuery && recent.length > 0) {
      out.push({
        id: "cap:recent",
        kind: "caption",
        text: t("action", "paletteRecent"),
      });
      for (const { item, context, path } of recent) {
        out.push({
          id: `recent:${context}/${item.crd ?? item.kind}/${item.namespace ?? ""}/${item.name}`,
          kind: "recent",
          path,
          name: item.name,
          resourceKind: item.kind,
          namespace: item.namespace ?? undefined,
          context,
          crd: item.crd,
        });
      }
    }

    const needle = query.toLowerCase();
    const links = quickActions
      .map((action) => ({
        ...action,
        key: action.label,
        label: t("action", action.label),
        english: english("action", action.label),
      }))
      .filter(
        (action) =>
          !hasQuery ||
          titleMatches(
            [action.label, action.english],
            wordsOf(action.words, t),
            needle
          )
      );
    const settingsLabel = t("action", "goToSettings");
    const settings =
      !hasQuery ||
      titleMatches(
        [settingsLabel, english("action", "goToSettings")],
        wordsOf("settings", t),
        needle
      );
    if (links.length > 0 || settings) {
      out.push({
        id: "cap:nav",
        kind: "caption",
        text: t("action", "paletteNavigation"),
      });
      for (const action of links) {
        out.push({
          id: `nav:${action.key}`,
          kind: "link",
          path: action.path,
          label: action.label,
          icon: action.icon,
        });
      }
      if (settings) {
        out.push({
          id: "settings",
          kind: "settings",
          label: settingsLabel,
          icon: Settings,
        });
      }
    }

    const served = isConnected
      ? matchingKinds(kinds, query, (kind) => wordsOf(kind, t))
      : [];
    if (served.length > 0) {
      out.push({
        id: "cap:kinds",
        kind: "caption",
        text: t("action", "paletteKinds"),
      });
      for (const entry of served) {
        out.push({
          id: `kind:${entry.group}/${entry.plural}`,
          kind: "kind",
          entry,
          path: servedListLink(entry),
        });
      }
    }

    // Under their own caption, not Navigation: they open a panel over the
    // page you are on rather than taking you anywhere.
    const panels = PANELS.map((panel) => ({
      ...panel,
      label: t("activity", panel.label),
      english: english("activity", panel.label),
    })).filter(
      (panel) =>
        !hasQuery ||
        titleMatches(
          [panel.label, panel.english],
          wordsOf(panel.tab, t),
          needle
        )
    );
    if (panels.length > 0) {
      out.push({
        id: "cap:activity",
        kind: "caption",
        text: t("activity", "title"),
      });
      for (const panel of panels) {
        out.push({
          id: `panel:${panel.tab}`,
          kind: "panel",
          tab: panel.tab,
          label: panel.label,
          icon: panel.icon,
        });
      }
    }
  }

  if (!hasQuery) {
    if (scoped) {
      out.push({
        id: "hint:scoped",
        kind: "hint",
        text:
          scope.kind === "all"
            ? t("empty", "typeToSearchAll")
            : t("empty", "typeToSearchContext", { context: scope.context }),
      });
    }
    return out;
  }

  if (!scoped && !isConnected) {
    out.push({
      id: "cap:res",
      kind: "caption",
      text: t("action", "paletteResources"),
    });
    out.push({
      id: "hint:offline",
      kind: "hint",
      text: t("empty", "connectOrBang"),
    });
    return out;
  }

  if (!isSearchable(query)) {
    out.push({
      id: "cap:res",
      kind: "caption",
      text: t("action", "paletteResources"),
    });
    out.push({
      id: "hint:short",
      kind: "hint",
      text: t("count", "typeAtLeastChars", { n: MIN_SEARCH_LENGTH }),
    });
    return out;
  }

  if (error) {
    out.push({
      id: "cap:res",
      kind: "caption",
      text: t("action", "paletteResources"),
    });
    out.push({ id: "hint:error", kind: "hint", text: error });
    return out;
  }

  for (const cluster of shownClusters) {
    out.push({
      id: `grp:${cluster.context}`,
      kind: "group",
      cluster,
      action: isCold(cluster)
        ? "search-it"
        : cluster.status === "failed"
          ? "retry"
          : "none",
    });
    // The search can list kinds the router serves no detail page for, and
    // there is no address to give them. A Namespace has a page, but here it
    // offers the stronger action: the scope the window is read under.
    // Nothing else unaddressable is offered, and it is dropped before the
    // cap so it neither takes a row nor counts in the rest. A hit links
    // into the cluster it was found in, which need not be this window's.
    const found = [
      ...(hitsByContext.get(cluster.context)?.values() ?? []),
    ].flatMap((hit): { hit: SearchHit; path: AppLink | null }[] => {
      if (isNamespaceHit(hit)) return [{ hit, path: null }];
      const path = servedObjectLink(hit, { cluster: hit.context });
      return path ? [{ hit, path }] : [];
    });
    const cap = shownClusters.length > 1 ? ROWS_PER_CLUSTER : found.length;
    for (const { hit, path } of found.slice(0, cap)) {
      out.push({
        id: `hit:${hit.context}/${hitKey(hit)}`,
        kind: "hit",
        hit,
        path,
      });
    }
    if (found.length > cap) {
      out.push({
        id: `more:${cluster.context}`,
        kind: "more",
        context: cluster.context,
        rest: found.length - cap,
      });
    }
    if (!saidAnything(cluster)) continue;
    // Only the window's own cluster has a catalogue here to count against.
    const own = !scoped && cluster.context === currentContext;
    const notSearched =
      own && kinds.length > 0 ? notSearchedOf(kinds, cluster) : null;
    out.push({
      id: `cov:${cluster.context}`,
      kind: "coverage",
      cluster,
      scope: scoped ? null : scopeLabel,
      notSearched,
      unreadGroups: own ? unreadGroups : 0,
    });
    const more = notSearched?.length ?? 0;
    if (own && !everything && more > 0 && cluster.status === "done") {
      out.push({ id: "search-more", kind: "search-more", count: more });
    }
  }

  // Rows, not hits: a cluster whose every match was a kind with nowhere to
  // go has shown the reader nothing.
  if (!out.some((entry) => entry.kind === "hit")) {
    const own = shownClusters.find(
      (cluster) => !scoped && cluster.context === currentContext
    );
    out.push({
      id: "hint:empty",
      kind: "hint",
      ...emptyHint({
        query,
        clusters: shownClusters,
        working,
        answered,
        notSearched:
          own && kinds.length > 0 ? notSearchedOf(kinds, own).length : 0,
        t,
      }),
    });
  }

  return out;
}

/**
 * The list while it shows one object's actions: whose they are, then each
 * action the text names. Reading the object first is said as reading, and a
 * failed read as what failed, never as an object with no actions.
 */
export function buildActionEntries({
  target,
  report,
  text,
  english,
  t,
}: {
  target: ActionTarget;
  report: ActionsReport | null;
  text: string;
  english: ReadonlyMap<string, string>;
  t: T;
}): Entry[] {
  const out: Entry[] = [{ id: "target", kind: "target", target }];
  if (report === null || report.reading === "pending") {
    out.push({
      id: "hint:reading",
      kind: "hint",
      tone: "loading",
      text: t("action", "readingObject", { name: target.name }),
    });
    return out;
  }
  if (report.reading === "failed") {
    out.push({
      id: "hint:unread",
      kind: "hint",
      tone: "unread",
      text: report.error,
    });
    return out;
  }
  const actions = paletteActionsOf(
    target,
    report.actions,
    report.busy,
    t
  ).filter((action) => actionMatches(action, english.get(action.id), text));
  for (const action of actions) {
    out.push({ id: `act:${action.id}`, kind: "action", target, action });
  }
  if (actions.length === 0) {
    out.push({
      id: "hint:no-action",
      kind: "hint",
      text: t("empty", "noActionMatches", { query: text.trim() }),
    });
  }
  return out;
}
