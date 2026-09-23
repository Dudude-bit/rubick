import type { ReactNode } from "react";
import {
  Activity,
  Box,
  FileText,
  LayoutDashboard,
  Network,
  Package,
  Server,
  Settings,
  Terminal,
} from "lucide-react";

import type { ActivityTab } from "@/stores/activityPanelStore";
import { isRoutableKind } from "@/components/resources/ResourceRef";
import {
  MIN_SEARCH_LENGTH,
  isSearchable,
  type ClusterSearchState,
  type SearchHit,
} from "@/hooks/useResourceSearch";
import {
  matchesAllClusters,
  parseBang,
  rankContexts,
} from "@/lib/cluster-search";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import {
  isResourceType,
  ResourceType,
  toKind,
  toPlural,
} from "@/lib/resource-registry";
import { aliasOf, type ClusterMark } from "@/stores/clusterIdentityStore";
import type { RecentItem } from "@/generated/types";
import type { T } from "@/i18n/useT";
import type { en } from "@/i18n/catalogue";
import { highlight } from "./palette-highlight";

const quickActions: Array<{
  icon: IconType;
  label: keyof typeof en.action;
  path: string;
}> = [
  { icon: LayoutDashboard, label: "goToOverview", path: "/" },
  {
    icon: Box,
    label: "goToPods",
    path: `/workloads/${toPlural(ResourceType.Pod)}`,
  },
  {
    icon: Box,
    label: "goToDeployments",
    path: `/workloads/${toPlural(ResourceType.Deployment)}`,
  },
  {
    icon: Network,
    label: "goToServices",
    path: `/network/${toPlural(ResourceType.Service)}`,
  },
  {
    icon: Server,
    label: "goToNodes",
    path: `/${toPlural(ResourceType.Node)}`,
  },
  {
    icon: FileText,
    label: "goToConfigMaps",
    path: `/configuration/${toPlural(ResourceType.ConfigMap)}`,
  },
  {
    icon: FileText,
    label: "goToSecrets",
    path: `/configuration/${toPlural(ResourceType.Secret)}`,
  },
  { icon: Activity, label: "goToEvents", path: "/events" },
  { icon: Package, label: "goToHelm", path: "/helm" },
];

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
  { kind: "current" } | { kind: "all" } | { kind: "context"; context: string };

/** One rendered line. Only some of them are places the arrows stop. */
export type Entry =
  | { id: string; kind: "caption"; text: ReactNode }
  | { id: string; kind: "hint"; text: ReactNode }
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
  | { id: string; kind: "hit"; hit: SearchHit; path: string | null }
  | { id: string; kind: "more"; context: string; rest: number }
  | { id: string; kind: "link"; path: string; label: string; icon: IconType }
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
      path: string;
      name: string;
      resourceKind: string;
      namespace?: string;
    };

export type IconType = React.ComponentType<{ className?: string }>;

/** What Enter does on a cluster's own row, when it does anything. */
export type GroupAction = "none" | "search-it" | "retry";

/** A hit that names a scope instead of an object the router can open. */
function isNamespaceHit(hit: SearchHit): boolean {
  return (
    isResourceType(hit.kind) && toKind(hit.kind) === ResourceType.Namespace
  );
}

export function isSelectable(entry: Entry): boolean {
  if (entry.kind === "caption" || entry.kind === "hint") return false;
  if (entry.kind === "group") return entry.action !== "none";
  return true;
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
  t: T;
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

  if (!scoped) {
    if (!hasQuery && recentItems.length > 0) {
      out.push({
        id: "cap:recent",
        kind: "caption",
        text: t("action", "paletteRecent"),
      });
      for (const item of recentItems) {
        out.push({
          id: `recent:${item.path}`,
          kind: "recent",
          path: item.path,
          name: item.name,
          resourceKind: item.kind,
          namespace: item.namespace ?? undefined,
        });
      }
    }

    const needle = query.toLowerCase();
    const links = quickActions
      .map((action) => ({ ...action, label: t("action", action.label) }))
      .filter(
        (action) => !hasQuery || action.label.toLowerCase().includes(needle)
      );
    const settingsLabel = t("action", "goToSettings");
    const settings = !hasQuery || settingsLabel.toLowerCase().includes(needle);
    if (links.length > 0 || settings) {
      out.push({
        id: "cap:nav",
        kind: "caption",
        text: t("action", "paletteNavigation"),
      });
      for (const action of links) {
        out.push({
          id: `nav:${action.path}`,
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

    // Under their own caption, not Navigation: they open a panel over the
    // page you are on rather than taking you anywhere.
    const panels = PANELS.map((panel) => ({
      ...panel,
      label: t("activity", panel.label),
    })).filter(
      (panel) => !hasQuery || panel.label.toLowerCase().includes(needle)
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
    const found = [...(hitsByContext.get(cluster.context)?.values() ?? [])];
    const cap = shownClusters.length > 1 ? ROWS_PER_CLUSTER : found.length;
    for (const hit of found.slice(0, cap)) {
      // The search can list kinds the router serves no detail page for, and
      // `getResourceDetailUrl` builds a URL for any of them: an unrouted
      // path inside the layout route matches no branch and blanks the shell.
      // A Namespace has a page, but here it offers the stronger action —
      // the scope the window is read under. Nothing else unrouted is offered.
      const routable = isRoutableKind(hit.kind, hit.namespace);
      if (!routable && !isNamespaceHit(hit)) continue;
      out.push({
        id: `hit:${hit.context}/${hit.kind}/${hit.namespace ?? ""}/${hit.name}`,
        kind: "hit",
        hit,
        path:
          routable && !isNamespaceHit(hit)
            ? getResourceDetailUrl(hit.kind, hit.name, hit.namespace)
            : null,
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
  }

  // Rows, not hits: a cluster whose every match was a kind with nowhere to
  // go has shown the reader nothing.
  if (!out.some((entry) => entry.kind === "hit")) {
    // "No results" while a cluster is still working is a lie, and so is
    // "no results" for a cluster nobody has connected to. The count is
    // the one thing a reader needs before believing an empty list.
    const total = shownClusters.length;
    const cold = shownClusters.filter(isCold).length;
    out.push({
      id: "hint:empty",
      kind: "hint",
      text: working
        ? t("empty", "noMatchesYet", { answered, total })
        : answered === 0
          ? t("empty", "nothingSearchedNoCluster")
          : cold > 0
            ? t("empty", "nothingMatchesOnSearched", {
                query,
                answered,
                total,
              })
            : t("empty", "nothingMatchesQuery", { query }),
    });
  }

  return out;
}
