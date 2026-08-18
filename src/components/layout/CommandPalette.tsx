import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  Box,
  FileText,
  LayoutDashboard,
  Network,
  Package,
  Search,
  Server,
  Settings,
  Terminal,
  X,
} from "lucide-react";

import {
  useActivityPanelStore,
  type ActivityTab,
} from "@/stores/activityPanelStore";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { ProviderMark } from "@/components/ui/provider-mark";
import {
  isRoutableKind,
  ResourceRef,
} from "@/components/resources/ResourceRef";
import {
  MIN_SEARCH_LENGTH,
  useResourceSearch,
  type ClusterSearchState,
  type SearchHit,
} from "@/hooks/useResourceSearch";
import { clusterColor, detectProvider } from "@/lib/cluster-identity";
import { commands } from "@/lib/commands";
import {
  matchesAllClusters,
  parseBang,
  rankContexts,
  splitMarks,
  type ContextMatch,
} from "@/lib/cluster-search";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import {
  isResourceType,
  ResourceType,
  toKind,
  toPlural,
} from "@/lib/resource-registry";
import { cn } from "@/lib/utils";
import {
  aliasOf,
  useClusterIdentityStore,
} from "@/stores/clusterIdentityStore";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { useClusterStore } from "@/stores/clusterStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";
import type { RecentItem } from "@/generated/types";
import { useT } from "@/i18n/useT";

const quickActions = [
  { icon: LayoutDashboard, label: "Go to Overview", path: "/" },
  {
    icon: Box,
    label: "Go to Pods",
    path: `/workloads/${toPlural(ResourceType.Pod)}`,
  },
  {
    icon: Box,
    label: "Go to Deployments",
    path: `/workloads/${toPlural(ResourceType.Deployment)}`,
  },
  {
    icon: Network,
    label: "Go to Services",
    path: `/network/${toPlural(ResourceType.Service)}`,
  },
  {
    icon: Server,
    label: "Go to Nodes",
    path: `/${toPlural(ResourceType.Node)}`,
  },
  {
    icon: FileText,
    label: "Go to ConfigMaps",
    path: `/configuration/${toPlural(ResourceType.ConfigMap)}`,
  },
  {
    icon: FileText,
    label: "Go to Secrets",
    path: `/configuration/${toPlural(ResourceType.Secret)}`,
  },
  { icon: Activity, label: "Go to Events", path: "/events" },
  { icon: Package, label: "Go to Helm", path: "/helm" },
  { icon: Settings, label: "Go to Settings", path: "/settings" },
];

/**
 * The Activity panel's three tabs, by the names a reader searches for.
 *
 * "Port forwards" is here because someone with one running could not find it:
 * the panel is a sheet behind a status-bar line, and the palette — the app's
 * own answer to not finding something — did not know it existed.
 */
const PANELS: Array<{ tab: ActivityTab; label: string; icon: IconType }> = [
  { tab: "ports", label: "Port forwards", icon: Network },
  { tab: "terminals", label: "Terminals", icon: Terminal },
  { tab: "jobs", label: "Background jobs", icon: Activity },
];

/**
 * Rows one cluster may spend while others are still answering.
 *
 * A fan-out is only honest if the reader can see who has answered, and one
 * cluster with twenty hits pushes every other cluster's line below the
 * fold — including the one that failed and the one still connecting. The
 * rest of that cluster's hits are one keystroke away on its own row.
 */
const ROWS_PER_CLUSTER = 5;

/**
 * The name the ladder landed on, with the part the reader typed marked.
 *
 * The unmatched text is dimmed only when there is something to dim it
 * against: with nothing typed yet every name is equally a candidate, and
 * greying the whole list says the opposite.
 */
function highlight(match: ContextMatch): ReactNode {
  return splitMarks(match.matched, match.marks).map((part, index) =>
    part.matched ? (
      <mark key={index} className="rounded-[2px] bg-warn/25 text-fg">
        {part.text}
      </mark>
    ) : (
      <span key={index} className={match.marks.length > 0 ? "text-fg-fnt" : ""}>
        {part.text}
      </span>
    )
  );
}

/**
 * Which clusters the query runs against.
 *
 * `current` is the default and is today's behaviour: every keystroke would
 * otherwise wake every connection in the kubeconfig. The other two are
 * reached by typing `!`, and both are visible afterwards as a chip.
 */
type Scope =
  { kind: "current" } | { kind: "all" } | { kind: "context"; context: string };

/**
 * The clusters the reader has explicitly agreed to open a connection to,
 * and the request that carries that agreement.
 *
 * `connect` is one flag for the whole fan-out, so the only way to wake
 * exactly the cluster that was asked for is to leave the other cold ones
 * out of the request — which is why the rows for those are kept here and
 * rendered from the snapshot. Without it a single Enter on one cluster
 * would run the credential plugin of every cluster in the kubeconfig.
 */
interface Wake {
  /** Contexts the request asks about, connecting where it must. */
  searched: string[];
  /** Cold clusters deliberately left out, still shown and still offered. */
  cold: ClusterSearchState[];
  /** Bumped by a retry, which is otherwise the identical request. */
  attempt: number;
}

/** One rendered line. Only some of them are places the arrows stop. */
type Entry =
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
  /**
   * A row that does something instead of going somewhere. Added because the
   * Activity panel — port forwards, terminals, background jobs — was a sheet
   * behind a status-bar line and therefore invisible to the one mechanism this
   * app offers for "I cannot find it".
   */
  | {
      id: string;
      kind: "panel";
      tab: ActivityTab;
      label: string;
      icon: IconType;
    }
  | {
      id: string;
      kind: "recent";
      path: string;
      name: string;
      resourceKind: string;
      namespace?: string;
    };

type IconType = React.ComponentType<{ className?: string }>;

/** What Enter does on a cluster's own row, when it does anything. */
type GroupAction = "none" | "search-it" | "retry";

/** A hit that names a scope instead of an object the router can open. */
function isNamespaceHit(hit: SearchHit): boolean {
  return (
    isResourceType(hit.kind) && toKind(hit.kind) === ResourceType.Namespace
  );
}

function isSelectable(entry: Entry): boolean {
  if (entry.kind === "caption" || entry.kind === "hint") return false;
  if (entry.kind === "group") return entry.action !== "none";
  return true;
}

function isCold(cluster: ClusterSearchState): boolean {
  return cluster.status === "skipped" && cluster.reason === "not-connected";
}

/** Said its piece about this query. "Not connected" is not one of them. */
function hasAnswered(cluster: ClusterSearchState): boolean {
  return cluster.status === "done" || cluster.status === "failed";
}

export function CommandPalette() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [scope, setScope] = useState<Scope>({ kind: "current" });
  const [wake, setWake] = useState<Wake | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [recentItems, setRecentItems] = useState<RecentItem[]>([]);

  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();

  const contexts = useClusterStore((s) => s.contexts);
  const currentContext = useClusterStore((s) => s.currentContext);
  const currentNamespace = useClusterStore((s) => s.currentNamespace);
  const namespaceScope = useNamespaceScope();
  const isConnected = useClusterStore((s) => s.isConnected);
  const switchNamespace = useClusterStore((s) => s.switchNamespace);
  const openActivityOn = useActivityPanelStore((s) => s.openOn);
  const marks = useClusterIdentityStore((s) => s.marks);
  const openTab = useScopeTabStore((s) => s.openTab);

  // A bang is only ever at the start, so it survives the rest of the query
  // being retyped and cannot be triggered by a `!` inside a resource name.
  const bang = useMemo(() => parseBang(text), [text]);
  const query = text.trim();
  const hasQuery = query.length > 0;
  const scoped = scope.kind !== "current";

  const scopeContexts = useMemo(() => {
    if (scope.kind === "context") return [scope.context];
    if (scope.kind === "all") return contexts.map((ctx) => ctx.name);
    return [];
  }, [scope, contexts]);

  const requestContexts = wake ? wake.searched : scopeContexts;

  const { hits, clusters, isSearching, error } = useResourceSearch({
    query,
    contexts: requestContexts,
    // Another cluster's namespaces are not this one's, so a scoped search
    // is a whole-cluster search; the unscoped one keeps today's filter.
    namespace: scoped ? null : currentNamespace || null,
    connect: wake !== null,
    attempt: wake?.attempt ?? 0,
    enabled: open && bang === null && (scoped || isConnected),
  });

  /** Cluster rows in the order they were asked, cold ones included. */
  const shownClusters = useMemo(() => {
    const byContext = new Map(clusters.map((c) => [c.context, c]));
    for (const cold of wake?.cold ?? []) {
      if (!byContext.has(cold.context)) byContext.set(cold.context, cold);
    }
    const order = scopeContexts.length
      ? scopeContexts
      : clusters.map((c) => c.context);
    // A cluster in the scope with nothing said about it yet is one the
    // request has just gone out for. Leaving it out of the list instead
    // would drop it off the screen for the length of a debounce.
    return order.map(
      (context): ClusterSearchState =>
        byContext.get(context) ?? {
          context,
          status: "searching",
          reason: null,
          message: null,
          matched: 0,
          truncated: false,
        }
    );
  }, [clusters, wake, scopeContexts]);

  const hitsByContext = useMemo(() => {
    const grouped = new Map<string, Map<string, SearchHit>>();
    // The unscoped search asks the cluster for one namespace or for all of
    // them, so a window narrowed to several has to keep what it wants here —
    // the same rule the lists follow, and for the same reason.
    // A search that has deliberately left this cluster's scope keeps every
    // hit: another cluster's namespaces are not this one's.
    for (const hit of scoped ? hits : namespaceScope.narrow(hits)) {
      const key = `${hit.kind}/${hit.namespace ?? ""}/${hit.name}`;
      const bucket = grouped.get(hit.context) ?? new Map<string, SearchHit>();
      bucket.set(key, hit);
      grouped.set(hit.context, bucket);
    }
    return grouped;
  }, [hits, scoped, namespaceScope]);

  const answered = shownClusters.filter(hasAnswered).length;
  /** At least one cluster is still connecting or listing, right now. */
  const working = shownClusters.some(
    (cluster) =>
      cluster.status === "searching" || cluster.status === "connecting"
  );

  // ----- what the list is made of -----

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];

    if (bang) {
      out.push({ id: "cap:clusters", kind: "caption", text: "Clusters" });
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
          meta: match.context === currentContext ? "live" : "not connected",
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
        out.push({ id: "cap:recent", kind: "caption", text: "Recent" });
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
      const links = quickActions.filter(
        (action) => !hasQuery || action.label.toLowerCase().includes(needle)
      );
      if (links.length > 0) {
        out.push({ id: "cap:nav", kind: "caption", text: "Navigation" });
        for (const action of links) {
          out.push({
            id: `nav:${action.path}`,
            kind: "link",
            path: action.path,
            label: action.label,
            icon: action.icon,
          });
        }
      }

      // Under their own caption, not Navigation: they open a panel over the
      // page you are on rather than taking you anywhere.
      const panels = PANELS.filter(
        (panel) => !hasQuery || panel.label.toLowerCase().includes(needle)
      );
      if (panels.length > 0) {
        out.push({ id: "cap:activity", kind: "caption", text: "Activity" });
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
              ? "Type to search every cluster you are connected to."
              : `Type to search ${scope.context}.`,
        });
      }
      return out;
    }

    if (!scoped && !isConnected) {
      out.push({ id: "cap:res", kind: "caption", text: "Resources" });
      out.push({
        id: "hint:offline",
        kind: "hint",
        text: "Connect to a cluster, or type ! to search another one.",
      });
      return out;
    }

    if (query.length < MIN_SEARCH_LENGTH) {
      out.push({ id: "cap:res", kind: "caption", text: "Resources" });
      out.push({
        id: "hint:short",
        kind: "hint",
        text: `Type at least ${MIN_SEARCH_LENGTH} characters to search resources.`,
      });
      return out;
    }

    if (error) {
      out.push({ id: "cap:res", kind: "caption", text: "Resources" });
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
        // A Namespace is not a page in this app — it is the scope a page is
        // read under — so that is what its row offers. Anything else with no
        // detail route is not offered at all.
        const routable = isRoutableKind(hit.kind, hit.namespace);
        if (!routable && !isNamespaceHit(hit)) continue;
        out.push({
          id: `hit:${hit.context}/${hit.kind}/${hit.namespace ?? ""}/${hit.name}`,
          kind: "hit",
          hit,
          path: routable
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
    // go has shown the reader nothing, and an empty list with no line under
    // it is the same silence the counts exist to break.
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
  }, [
    answered,
    bang,
    contexts,
    currentContext,
    error,
    hasQuery,
    hitsByContext,
    isConnected,
    marks,
    query,
    recentItems,
    scope,
    scoped,
    shownClusters,
    working,
    t,
  ]);

  const selectable = useMemo(() => entries.filter(isSelectable), [entries]);
  // Selection follows the row, not its position: groups arrive as each
  // cluster answers, and an index would slide the highlight onto whatever
  // the slowest cluster pushed into that slot.
  const activeId =
    selectable.find((entry) => entry.id === selectedId)?.id ??
    selectable[0]?.id ??
    null;

  // ----- acting on it -----

  const close = useCallback(() => setOpen(false), []);

  const go = useCallback(
    (
      path: string,
      remember?: { name: string; kind: string; namespace?: string }
    ) => {
      if (remember) {
        commands
          .addRecentItem({
            ...remember,
            path,
            namespace: remember.namespace ?? undefined,
            timestamp: Date.now(),
          })
          .catch(() => {});
      }
      close();
      requestAnimationFrame(() => navigate(path));
    },
    [close, navigate]
  );

  const pickScope = useCallback(
    (next: Scope) => {
      setScope(next);
      setWake(null);
      setText(bang?.rest ?? "");
      inputRef.current?.focus();
    },
    [bang]
  );

  /**
   * Agree to open a connection to one cold cluster, or ask a failed one
   * again. Everything already answering stays in the request; every other
   * cold cluster stays out of it, and out of its credential plugin.
   */
  const wakeCluster = useCallback(
    (context: string) => {
      setWake((previous) => {
        const searched = shownClusters
          .filter((c) => c.context === context || !isCold(c))
          .map((c) => c.context);
        return {
          searched,
          cold: shownClusters.filter((c) => c.context !== context && isCold(c)),
          attempt: (previous?.attempt ?? 0) + 1,
        };
      });
    },
    [shownClusters]
  );

  const activate = useCallback(
    (entry: Entry, newTab: boolean) => {
      switch (entry.kind) {
        case "all-clusters":
          pickScope({ kind: "all" });
          return;
        case "cluster":
          pickScope({ kind: "context", context: entry.context });
          return;
        case "group":
          if (entry.action !== "none") wakeCluster(entry.cluster.context);
          return;
        case "more":
          // The rest of one cluster's hits is that cluster on its own,
          // which is a scope the reader already has a word for.
          setScope({ kind: "context", context: entry.context });
          setWake(null);
          inputRef.current?.focus();
          return;
        case "hit": {
          const { hit } = entry;
          // A namespace is a scope, so picking one points this window at it —
          // the same verb the namespaces list offers — and leaves the reader
          // on the page they were reading, now under that scope.
          if (entry.path === null) {
            if (newTab || hit.context !== currentContext) {
              openTab({
                context: hit.context,
                namespace: hit.name,
                background: newTab,
              });
            } else {
              void switchNamespace(hit.name);
            }
            close();
            return;
          }
          // Crossing a cluster boundary costs a tab: switching this one
          // would pull the ground out from under the page being read.
          if (newTab || hit.context !== currentContext) {
            openTab({
              href: entry.path,
              context: hit.context,
              namespace: hit.namespace ?? "",
              background: newTab,
            });
            close();
            return;
          }
          go(entry.path, {
            name: hit.name,
            kind: hit.kind,
            namespace: hit.namespace ?? undefined,
          });
          return;
        }
        case "recent":
          if (newTab) {
            openTab({ href: entry.path, background: true });
            close();
            return;
          }
          go(entry.path, {
            name: entry.name,
            kind: entry.resourceKind,
            namespace: entry.namespace,
          });
          return;
        case "link":
          if (newTab) {
            openTab({ href: entry.path, background: true });
            close();
            return;
          }
          go(entry.path);
          return;
        case "panel":
          // Nothing to open in a tab: it is a panel over the current page,
          // not a page of its own.
          openActivityOn(entry.tab);
          close();
          return;
        default:
          return;
      }
    },
    [
      close,
      currentContext,
      go,
      openActivityOn,
      openTab,
      pickScope,
      switchNamespace,
      wakeCluster,
    ]
  );

  const move = useCallback(
    (delta: number) => {
      if (selectable.length === 0) return;
      const at = selectable.findIndex((entry) => entry.id === activeId);
      const next = Math.min(
        Math.max((at === -1 ? 0 : at) + delta, 0),
        selectable.length - 1
      );
      setSelectedId(selectable[next].id);
    },
    [activeId, selectable]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      const entry = selectable.find((item) => item.id === activeId);

      if (event.key === "ArrowDown") {
        event.preventDefault();
        move(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        move(-1);
        return;
      }
      // Tab writes the whole cluster name into the field, so the next
      // keystroke narrows from a name that is certainly real.
      if (event.key === "Tab" && bang) {
        event.preventDefault();
        if (entry?.kind === "cluster") setText(`!${entry.context}`);
        else if (entry?.kind === "all-clusters") setText("!*");
        return;
      }
      if (event.key === "Enter") {
        if (!entry) return;
        event.preventDefault();
        activate(entry, event.metaKey || event.ctrlKey);
        return;
      }
      // The chip is a token in the field, and every token field in the app
      // gives it back to backspace at an empty caret.
      if (event.key === "Backspace" && text === "" && scoped) {
        event.preventDefault();
        setScope({ kind: "current" });
        setWake(null);
      }
    },
    [activate, activeId, bang, move, scoped, selectable, text]
  );

  // ----- lifecycle -----

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setOpen((previous) => !previous);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("command-palette-open", onOpen);
    return () => window.removeEventListener("command-palette-open", onOpen);
  }, []);

  // Reset on every open/close transition. Genuine sync-prop-into-state —
  // a `key`-style remount would be cleaner but the palette is mounted at
  // the app root.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      commands
        .getRecentItems()
        .then(setRecentItems)
        .catch(() => setRecentItems([]));
    } else {
      setText("");
      setScope({ kind: "current" });
      setWake(null);
      setSelectedId(null);
    }
  }, [open]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Arrowing past the fold has to bring the row with it — the field keeps
  // the focus, so the browser will not do it. Optional call because jsdom
  // does not implement it.
  useEffect(() => {
    if (activeId === null) return;
    document
      .getElementById(`${listId}-${activeId}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeId, listId]);

  // ----- the surface -----

  const scopeLabel =
    scope.kind === "all"
      ? "all clusters"
      : scope.kind === "context"
        ? scope.context
        : null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="z-60 max-w-[620px] gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Command palette</DialogTitle>

        {/* One field on the raised surface. A bordered input inside an
            overlay is a second surface on top of the only surface the
            design allows — the hairline below is the whole chrome. */}
        <div className="flex items-center gap-2 border-b border-hair px-3 py-2.5 text-fg-fnt">
          <Search className="h-3.5 w-3.5 flex-none" />
          {scopeLabel && (
            <ScopeChip
              label={scopeLabel}
              onRemove={() => {
                setScope({ kind: "current" });
                setWake(null);
                inputRef.current?.focus();
              }}
            />
          )}
          <input
            ref={inputRef}
            autoFocus
            aria-label="Search resources, actions and pages"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={
              activeId ? `${listId}-${activeId}` : undefined
            }
            placeholder={
              scopeLabel
                ? "Search this cluster…"
                : "Search resources, or ! for a cluster…"
            }
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full bg-transparent text-[13px] text-fg outline-hidden placeholder:text-fg-fnt"
          />
        </div>

        <div
          id={listId}
          role="listbox"
          aria-label="Results"
          className="max-h-[380px] overflow-y-auto p-1 scrollbar-thin"
        >
          {entries.map((entry) => (
            <EntryRow
              key={entry.id}
              domId={`${listId}-${entry.id}`}
              entry={entry}
              selected={entry.id === activeId}
              onHover={() => isSelectable(entry) && setSelectedId(entry.id)}
              onPick={(event) =>
                activate(
                  entry,
                  event.metaKey || event.ctrlKey || event.button === 1
                )
              }
            />
          ))}
        </div>

        <div className="flex items-center gap-3.5 border-t border-hair px-3 py-1.5 text-[11px] text-fg-fnt">
          {bang ? (
            <>
              <FootKey shortcut="↵">scope to it</FootKey>
              <FootKey shortcut="⇥">complete</FootKey>
              <span className="ml-auto">
                type <span className="font-mono text-fg-mut">!*</span> for all
              </span>
            </>
          ) : (
            <>
              <FootKey shortcut="↑↓">move</FootKey>
              <FootKey shortcut="↵">open</FootKey>
              <FootKey shortcut="mod+↵">new tab</FootKey>
              {scoped ? (
                <FootKey shortcut="⌫">drop the cluster</FootKey>
              ) : (
                <FootKey shortcut="!">a cluster</FootKey>
              )}
              {shownClusters.length > 1 && hasQuery && (
                <span className="ml-auto">
                  {answered} of {shownClusters.length} clusters answered
                  {isSearching && " · results appear as each one does"}
                </span>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FootKey({
  shortcut,
  children,
}: {
  shortcut: string;
  children: ReactNode;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <Kbd shortcut={shortcut} />
      {children}
    </span>
  );
}

/**
 * The resolved bang.
 *
 * The same object the log query's terms are, down to the hue and the inset
 * edge, so a reader who learned one already knows this one: visible,
 * removable, and it survives while the rest of the query is retyped.
 */
function ScopeChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex shrink-0 items-center rounded bg-info/16 font-mono text-[11px] leading-[18px] text-info ring-1 ring-inset ring-info/45">
      <span className="flex items-center gap-1 pl-1.5">
        <span aria-hidden="true">!</span>
        {label}
      </span>
      <button
        type="button"
        // Not a tab stop: the caret never leaves the field, and backspace
        // on an empty query does exactly this.
        tabIndex={-1}
        aria-label={`Search every cluster's own scope again — drop ${label}`}
        title={`Drop ${label}`}
        onClick={onRemove}
        className="pr-1 text-info/70 transition-colors hover:text-err"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

function EntryRow({
  domId,
  entry,
  selected,
  onHover,
  onPick,
}: {
  domId: string;
  entry: Entry;
  selected: boolean;
  onHover: () => void;
  onPick: (event: ReactMouseEvent) => void;
}) {
  if (entry.kind === "caption") {
    return (
      <div
        role="presentation"
        className="px-2 pb-0.5 pt-2 text-[11px] text-fg-fnt first:pt-1"
      >
        {entry.text}
      </div>
    );
  }

  if (entry.kind === "hint") {
    return <p className="px-2 py-1.5 text-xs text-fg-mut">{entry.text}</p>;
  }

  if (entry.kind === "group") {
    return (
      <ClusterGroup
        domId={domId}
        entry={entry}
        selected={selected}
        onHover={onHover}
        onPick={onPick}
      />
    );
  }

  const shared = {
    domId,
    selected,
    onHover,
    onPick,
  };

  switch (entry.kind) {
    case "all-clusters":
      return (
        <Row {...shared}>
          <span className="h-1.5 w-1.5 flex-none rounded-full border border-fg-fnt" />
          <span className="min-w-0 truncate font-mono">all clusters</span>
          {/* `!*` does not connect to anything on its own: on a laptop
              with fifteen contexts that would be fifteen auth prompts
              from one keystroke. */}
          <span className="ml-auto flex-none text-[11px] text-fg-fnt">
            already-connected ones are searched
          </span>
        </Row>
      );
    case "cluster":
      return (
        <Row {...shared}>
          <span
            className="h-1.5 w-1.5 flex-none rounded-full"
            style={{ background: clusterColor(entry.context, entry.hue) }}
          />
          <ProviderMark
            provider={detectProvider(entry.context)}
            className="h-[13px] w-[13px] flex-none"
          />
          <span className="flex min-w-0 flex-col">
            {/* A name a person typed is prose; a context name is a token
                you paste into a shell. Only the second one is mono. */}
            <span className={cn("truncate", !entry.sub && "font-mono")}>
              {entry.label}
            </span>
            {entry.sub && (
              <span className="truncate font-mono text-[10px] leading-[13px] text-fg-fnt">
                {entry.sub}
              </span>
            )}
          </span>
          <span className="ml-auto flex-none text-[11px] text-fg-fnt">
            {entry.meta}
          </span>
        </Row>
      );
    case "hit":
      return (
        <Row {...shared}>
          {/* No `truncate` here: a reference clips its own name, and
              clipping it twice shrinks the row to a few characters. */}
          <span className="min-w-0">
            <ResourceRef
              kind={entry.hit.kind}
              name={entry.hit.name}
              namespace={entry.hit.namespace}
              showKind={false}
              onClick={(event) => {
                event.preventDefault();
                onPick(event);
              }}
            />
          </span>
          {entry.hit.namespace && (
            <span className="truncate text-fg-fnt">{entry.hit.namespace}</span>
          )}
          {/* Where the namespace would be, because for this row the name
              already is one and what the reader gets is the scope. */}
          {entry.path === null && (
            <span className="truncate text-fg-fnt">scope to it</span>
          )}
          <span className="ml-auto flex-none text-[11px] text-fg-fnt">
            {entry.hit.kind}
          </span>
        </Row>
      );
    case "recent":
      return (
        <Row {...shared}>
          <span className="min-w-0">
            <ResourceRef
              kind={entry.resourceKind}
              name={entry.name}
              namespace={entry.namespace}
              showKind={false}
              onClick={(event) => {
                event.preventDefault();
                onPick(event);
              }}
            />
          </span>
          {entry.namespace && (
            <span className="truncate text-fg-fnt">{entry.namespace}</span>
          )}
          <span className="ml-auto flex-none text-[11px] text-fg-fnt">
            {entry.resourceKind}
          </span>
        </Row>
      );
    case "more":
      return (
        <Row {...shared}>
          <span className="min-w-0 truncate text-fg-fnt">
            {entry.rest} more on this cluster
          </span>
          <span className="ml-auto flex flex-none items-center gap-1 text-[11px] text-fg-fnt">
            <Kbd shortcut="↵" /> scope to it
          </span>
        </Row>
      );
    case "link":
      return (
        <Row {...shared}>
          <entry.icon className="h-3.5 w-3.5 flex-none text-fg-fnt" />
          <span className="min-w-0 truncate">{entry.label}</span>
        </Row>
      );
    case "panel":
      return (
        <Row {...shared}>
          <entry.icon className="h-3.5 w-3.5 flex-none text-fg-fnt" />
          <span className="min-w-0 truncate">{entry.label}</span>
        </Row>
      );
    default:
      return null;
  }
}

/**
 * One cluster's own line: which cluster, and what it has said so far.
 *
 * Four different truths share this row and none of them may pretend to be
 * another. Still connecting is not "no results"; failed says why and
 * offers to be asked again; and a cluster nobody has connected to is not
 * woken silently, because its credential plugin can prompt — so searching
 * it is a keystroke the reader presses on purpose.
 */
function ClusterGroup({
  domId,
  entry,
  selected,
  onHover,
  onPick,
}: {
  domId: string;
  entry: Extract<Entry, { kind: "group" }>;
  selected: boolean;
  onHover: () => void;
  onPick: (event: ReactMouseEvent) => void;
}) {
  const { cluster, action } = entry;
  const working =
    cluster.status === "searching" || cluster.status === "connecting";

  let state: ReactNode;
  let tone = "text-fg-mut";
  if (cluster.status === "connecting") {
    state = "connecting…";
    tone = "text-info";
  } else if (cluster.status === "searching") {
    state = "searching…";
    tone = "text-info";
  } else if (cluster.status === "failed") {
    state = (
      <>
        {cluster.message ?? "failed"} — <Kbd shortcut="↵" /> retry
      </>
    );
    tone = "text-err";
  } else if (cluster.status === "skipped") {
    state =
      cluster.reason === "not-connected" ? (
        <>
          not connected — <Kbd shortcut="↵" /> to search it
        </>
      ) : (
        "not in the kubeconfig"
      );
  } else {
    state = cluster.matched === 0 ? "no matches" : `${cluster.matched} matches`;
    if (cluster.truncated) state = `${cluster.matched}+ matches · capped`;
  }

  return (
    <div
      {...(action === "none"
        ? { role: "presentation" }
        : {
            role: "option",
            "aria-selected": selected,
            onClick: onPick,
            onMouseEnter: onHover,
          })}
      id={domId}
      className={cn(
        "mt-1 flex items-center gap-2 rounded-[5px] px-2 py-1 text-[11px] first:mt-0",
        action !== "none" && "cursor-pointer hover:bg-hover",
        selected && action !== "none" && "bg-sel"
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 flex-none rounded-full",
          cluster.status === "done" && "bg-ok",
          working && "animate-pulse-subtle bg-info",
          cluster.status === "failed" && "bg-err",
          cluster.status === "skipped" && "border border-fg-fnt"
        )}
      />
      <span className="min-w-0 truncate font-mono text-fg-mut">
        {cluster.context}
      </span>
      <span className={cn("ml-auto flex flex-none items-center gap-1", tone)}>
        {state}
      </span>
    </div>
  );
}

function Row({
  domId,
  selected,
  onHover,
  onPick,
  children,
}: {
  domId: string;
  selected: boolean;
  onHover: () => void;
  onPick: (event: ReactMouseEvent) => void;
  children: ReactNode;
}) {
  return (
    // A div, not a button: a resource row names its object with a
    // `ResourceRef`, and an anchor inside a button is not a thing the
    // browser will render. Arrows and Enter are handled by the field.
    <div
      id={domId}
      role="option"
      aria-selected={selected}
      onClick={onPick}
      onAuxClick={(event) => event.button === 1 && onPick(event)}
      onMouseEnter={onHover}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded-[5px] px-2 py-[5px] text-left text-xs transition-colors hover:bg-hover",
        selected ? "bg-sel text-fg" : "text-fg-mid"
      )}
    >
      {children}
    </div>
  );
}
