import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Search } from "lucide-react";

import { ClusterRow } from "@/components/cluster/ClusterRow";
import { Kbd } from "@/components/ui/kbd";
import { ProviderMark } from "@/components/ui/provider-mark";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useClusterSummary } from "@/hooks/useClusterSummary";
import {
  clusterColor,
  detectProvider,
  providerLabel,
} from "@/lib/cluster-identity";
import { cn } from "@/lib/utils";
import {
  splitByRecency,
  useClusterRecencyStore,
} from "@/stores/clusterRecencyStore";
import { useClusterStore } from "@/stores/clusterStore";
import {
  tabRouteLabel,
  tabTitle,
  useScopeTabStore,
  type ScopeTab,
} from "@/stores/scopeTabStore";

const ALL_NAMESPACES = "all namespaces";

/**
 * The window's tab strip. A tab is a route plus the scope it is read under,
 * and the cluster and the namespace are separate click targets: namespaces
 * change dozens of times an hour and clusters a few times a day, so a
 * single merged list would bury the frequent job under the rare one.
 *
 * What a tab says, in the order it gives things up:
 *
 * 1. The cluster's colour dot and provider mark are never dropped and never
 *    shrink — acting on the wrong cluster is the expensive mistake here.
 * 2. The route is the tab's name and the only part of it that is written
 *    nowhere else on screen, so it shrinks last and has a floor of its own.
 * 3. The namespace gives way first, because the active tab's namespace is
 *    also the one the page itself is filtered by.
 * 4. The cluster's *name* is spent only where it discriminates: a strip
 *    holding one cluster drops it on every tab, because the sidebar has
 *    just said it and the dot still guards the mistake. The moment a second
 *    cluster is open, every tab names itself.
 *
 * Width is shrink-to-a-floor-then-scroll, the Firefox rule rather than the
 * Chrome one: tabs take their natural width, shrink together as the strip
 * fills, and stop at a floor wide enough to still read a route. Past that
 * the strip scrolls instead of grinding every tab into an unreadable
 * sliver. Nothing stretches, so one tab is one tab's worth of chrome.
 */
export function ScopeTabs() {
  const currentContext = useClusterStore((s) => s.currentContext);
  const currentNamespace = useClusterStore((s) => s.currentNamespace);
  const isConnected = useClusterStore((s) => s.isConnected);
  const isLoading = useClusterStore((s) => s.isLoading);
  const isAuthenticating = useClusterStore((s) => s.isAuthenticating);
  const error = useClusterStore((s) => s.error);
  const pendingContext = useClusterStore((s) => s.pendingContext);
  const loadContexts = useClusterStore((s) => s.loadContexts);
  const connect = useClusterStore((s) => s.connect);

  const tabs = useScopeTabStore((s) => s.tabs);
  const activeId = useScopeTabStore((s) => s.activeId);

  const stripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadContexts();
  }, [loadContexts]);

  // The kubeconfig's current context is only a name until something
  // connects to it; nothing else in the app does.
  useEffect(() => {
    if (
      currentContext &&
      !isConnected &&
      !isLoading &&
      !isAuthenticating &&
      !error &&
      !pendingContext
    ) {
      connect(currentContext);
    }
  }, [
    currentContext,
    isConnected,
    isLoading,
    isAuthenticating,
    error,
    pendingContext,
    connect,
  ]);

  // Scrolling is only an acceptable overflow policy if the tab you just
  // switched to cannot be the one off the edge. Ctrl+1..9 and Ctrl+Tab
  // reach every tab; this is what makes them land somewhere visible.
  useEffect(() => {
    stripRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  // The active tab's scope lives in `clusterStore`, not on the tab; a tab
  // whose cluster is gone keeps the name it was pointed at, because nothing
  // else remembers it.
  const shown = useMemo(
    () =>
      tabs.map((tab) =>
        tab.id === activeId && !tab.missing
          ? { ...tab, context: currentContext, namespace: currentNamespace }
          : tab
      ),
    [tabs, activeId, currentContext, currentNamespace]
  );

  const multiCluster =
    new Set(shown.map((tab) => tab.context).filter(Boolean)).size > 1;

  return (
    <div className="flex h-[38px] flex-none items-center gap-1 border-b border-hair px-2.5">
      {/* Outside the scroller on purpose: however far the strip has been
          scrolled, the way to open a tab has not moved. */}
      <NewTabButton />

      <div
        ref={stripRef}
        role="tablist"
        aria-label="Open scopes"
        // A tab strip is one line, so a trackpad's vertical gesture is the
        // gesture a reader will use on it.
        onWheel={(event) => {
          const el = event.currentTarget;
          if (el.scrollWidth <= el.clientWidth) return;
          el.scrollLeft += event.deltaY || event.deltaX;
        }}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-none"
      >
        {shown.map((tab) => (
          <ScopeTabItem
            key={tab.id}
            tab={tab}
            active={tab.id === activeId}
            namesCluster={multiCluster}
            closable={shown.length > 1}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={() =>
          window.dispatchEvent(new CustomEvent("command-palette-open"))
        }
        className="flex flex-none items-center gap-1 rounded-md px-2 py-1 text-[11px] leading-[14px] text-fg-mut transition-colors hover:bg-hover hover:text-fg"
      >
        Search
        <Kbd shortcut="mod+K" className="leading-[13px]" />
      </button>
    </div>
  );
}

/**
 * The way to open a tab, in its two meanings.
 *
 * A left click opens a tab on the cluster already on screen: a browser's
 * new tab lands on a home page, not on a picker, and inheriting the
 * connection makes the shortcut instant.
 *
 * The other reason to open a tab is to go somewhere else, and that used to
 * be what this button did — until a tab became a route plus a scope, which
 * made picking a cluster afterwards a second step. Right click gives it
 * back: one gesture, one new tab, on the cluster you named.
 */
function NewTabButton() {
  const contexts = useClusterStore((s) => s.contexts);
  const currentContext = useClusterStore((s) => s.currentContext);
  const openTab = useScopeTabStore((s) => s.openTab);
  const [menu, setMenu] = useState(false);
  const [tip, setTip] = useState(false);

  return (
    <ContextMenu onOpenChange={setMenu}>
      <Tooltip open={tip && !menu} onOpenChange={setTip}>
        <TooltipTrigger asChild>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              aria-label="New tab. Menu key opens it on another cluster."
              aria-haspopup="menu"
              onClick={() => openTab()}
              className="flex-none rounded-md px-[7px] py-[3px] text-[12px] leading-[15px] text-fg-fnt transition-colors hover:bg-hover hover:text-fg"
            >
              +
            </button>
          </ContextMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[240px]">
          <p className="flex items-center gap-1.5">
            New tab here
            <Kbd shortcut="mod+T" className="leading-[13px]" />
          </p>
          <p className="mt-0.5">Right click for another cluster.</p>
        </TooltipContent>
      </Tooltip>

      <ContextMenuContent className="w-[244px]">
        <ContextMenuLabel>New tab on</ContextMenuLabel>
        {contexts.length === 0 && (
          <p className="px-[7px] py-2 text-[11px] text-fg-fnt">
            No contexts in the kubeconfig.
          </p>
        )}
        {contexts.map((ctx) => {
          const color = clusterColor(ctx.name);
          return (
            <ContextMenuItem
              key={ctx.name}
              onSelect={() => openTab({ context: ctx.name })}
              className="grid grid-cols-[6px_1fr] items-center gap-[9px]"
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: color }}
              />
              <span className="flex items-center gap-[7px] overflow-hidden">
                <ProviderMark
                  provider={detectProvider(ctx.name)}
                  style={{ color }}
                />
                <span className="truncate font-mono">{ctx.name}</span>
              </span>
            </ContextMenuItem>
          );
        })}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => openTab()}>
          {/* Named by what it does rather than by the cluster, because the
              cluster it lands on is whichever one is on screen. */}
          New tab here
          <span className="ml-auto pl-4 text-fg-fnt">
            {currentContext ?? "no cluster"}
          </span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ScopeTabItem({
  tab,
  active,
  namesCluster,
  closable,
}: {
  tab: ScopeTab;
  active: boolean;
  /** The strip holds more than one cluster, so the name is worth its width. */
  namesCluster: boolean;
  /** The strip has somewhere to fall back to if this tab goes. */
  closable: boolean;
}) {
  const { context, namespace } = tab;
  const switchContext = useClusterStore((s) => s.switchContext);
  const switchNamespace = useClusterStore((s) => s.switchNamespace);
  const connect = useClusterStore((s) => s.connect);
  const activateTab = useScopeTabStore((s) => s.activateTab);
  const closeTab = useScopeTabStore((s) => s.closeTab);

  const [open, setOpen] = useState<"ctx" | "ns" | null>(null);
  const [tip, setTip] = useState(false);
  const color = clusterColor(context);
  const route = tabRouteLabel(tab.href);
  // A cluster the kubeconfig has lost is the odd one out however many
  // clusters are open — that is exactly when the name is the fact the
  // reader needs.
  const showName = namesCluster || tab.missing;

  // A segment on a parked tab is a way back to that scope, not a picker
  // for it: opening a list that edits a scope the window is not showing
  // would act on the wrong cluster, which is the mistake this strip
  // exists to prevent.
  const guard = (which: "ctx" | "ns") => (next: boolean) => {
    if (!active) {
      activateTab(tab.id);
      return;
    }
    setOpen(next ? which : null);
  };

  const pickCluster = (next: string) => {
    setOpen(null);
    if (next === context) return;
    switchContext(next);
    connect(next);
  };

  // A tab with no cluster keeps its place — it is where a cluster gets
  // picked, so it cannot vanish — but it stops describing an absence.
  // `no cluster / all namespaces / overview` is two segments naming a
  // scope that cannot exist and a page with nothing on it; one segment
  // survives, and it is a verb.
  if (!context && !tab.missing) {
    return (
      <div
        role="tab"
        aria-selected={active}
        data-active={active}
        onClick={() => {
          if (!active) activateTab(tab.id);
        }}
        onAuxClick={(event) => {
          if (event.button !== 1 || !closable) return;
          event.preventDefault();
          closeTab(tab.id);
        }}
        className="flex flex-none items-center gap-[5px] rounded-md px-[9px] py-1 text-[12px] leading-[15px]"
      >
        <ContextPopover
          open={open === "ctx"}
          onOpenChange={guard("ctx")}
          activeContext={null}
          onSelect={pickCluster}
        >
          <button
            type="button"
            className={cn(
              segClass(open === "ctx"),
              "text-info ring-1 ring-inset ring-info/45 hover:bg-info/10",
              open === "ctx" && "bg-info/10 hover:bg-info/10"
            )}
          >
            <ProviderMark
              provider="generic"
              className="h-[13px] w-[13px] flex-none"
            />
            Choose a cluster
          </button>
        </ContextPopover>
        {closable && (
          <button
            type="button"
            aria-label="Close tab"
            onClick={(event) => {
              event.stopPropagation();
              closeTab(tab.id);
            }}
            className="flex-none pl-0.5 text-fg-fnt transition-colors hover:text-fg"
          >
            <span aria-hidden="true">✕</span>
          </button>
        )}
      </div>
    );
  }

  return (
    // Controlled, so the tooltip stands down while a picker is open rather
    // than floating over the list the reader is trying to read — which is
    // what the native `title` did and could not be told not to.
    <Tooltip open={tip && open === null} onOpenChange={setTip}>
      <TooltipTrigger asChild>
        <div
          role="tab"
          aria-selected={active}
          aria-label={tabTitle(tab)}
          data-active={active}
          onClick={() => {
            if (!active) activateTab(tab.id);
          }}
          // Middle-click closes, as it does on every tab strip the reader has
          // used. `onClick` never fires for the middle button.
          onAuxClick={(event) => {
            if (event.button !== 1) return;
            event.preventDefault();
            closeTab(tab.id);
          }}
          className={cn(
            // Natural width, no growing, a cap a long object name reaches
            // and a floor it stops at: an empty strip is not a reason to
            // stretch a tab, and a contested one gives up characters before
            // it gives up tabs. Below the floor the strip scrolls.
            //
            // The floor is stated here rather than left to the segments'
            // own minimums because a flex item's intrinsic minimum is not
            // reliably the sum of its children's, and a tab narrower than
            // its own parts is a tab with its label written over itself —
            // hence `overflow-hidden` as the backstop.
            "flex max-w-[26rem] shrink items-center gap-[5px] overflow-hidden rounded-md px-[9px] py-1 text-[12px] leading-[15px] transition-colors",
            // A lost cluster needs room for the one fact only this tab still
            // holds — the name it was pointed at — and for the word that says
            // it is gone.
            tab.missing
              ? "min-w-[21rem]"
              : showName
                ? "min-w-[17.5rem]"
                : "min-w-[13.5rem]",
            active ? "bg-sel text-fg-mut" : "text-fg-fnt hover:bg-hover"
          )}
        >
          <ContextPopover
            open={open === "ctx"}
            onOpenChange={guard("ctx")}
            activeContext={context}
            onSelect={pickCluster}
          >
            <button
              type="button"
              className={cn(
                segClass(open === "ctx"),
                showName ? "min-w-[4rem] [flex-shrink:6]" : "flex-none",
                tab.missing && "min-w-[6.5rem]"
              )}
            >
              {/* Only the dot carries the cluster colour here — the mark
                  stays at text contrast so the tab reads as one label and
                  the colour signal has a single owner. A cluster the
                  kubeconfig has lost gets a ring instead of a fill, so the
                  state survives with the hue taken away. */}
              <span
                className={cn(
                  "h-1.5 w-1.5 flex-none rounded-full",
                  tab.missing && "border border-fg-fnt"
                )}
                style={tab.missing ? undefined : { background: color }}
              />
              <ProviderMark
                provider={detectProvider(context ?? "")}
                className="h-[13px] w-[13px] flex-none"
              />
              {showName && (
                <span className="min-w-0 truncate">
                  {context ?? "no cluster"}
                </span>
              )}
            </button>
          </ContextPopover>

          {/* Not a suffix on the name but a state of the tab, in the same
              micro-label the context list uses for a provider. The tab
              cannot be made live and nothing about it is going to change
              until the kubeconfig does. */}
          {tab.missing && (
            <span className="flex-none rounded border border-hair px-1 text-[10px] uppercase leading-[13px] tracking-[0.05em] text-fg-fnt">
              missing
            </span>
          )}

          <span aria-hidden="true" className="flex-none text-fg-fnt">
            /
          </span>

          <NamespacePopover
            open={open === "ns"}
            onOpenChange={guard("ns")}
            namespace={namespace}
            onSelect={(next) => {
              setOpen(null);
              switchNamespace(next);
            }}
          >
            <button
              type="button"
              // A floor here as well as on the route: a namespace ground
              // down to a bare chevron is not a shorter label, it is a
              // segment that has stopped saying anything and kept its
              // punctuation.
              className={cn(
                segClass(open === "ns"),
                "min-w-[3.5rem] [flex-shrink:6]"
              )}
            >
              <span className="min-w-0 truncate">
                {namespace || ALL_NAMESPACES}
              </span>
              <span aria-hidden="true" className="flex-none text-[9px]">
                ▾
              </span>
            </button>
          </NamespacePopover>

          <span aria-hidden="true" className="flex-none text-fg-fnt">
            /
          </span>

          {/* The tab's name. One `/` throughout makes cluster, namespace and
              page one path — the same trail a detail page draws — and the
              page end of it carries the strongest colour in the tab,
              because it is the part that says which tab this is. */}
          <span
            className={cn(
              "min-w-[4.5rem] truncate [flex-shrink:1]",
              active ? "text-fg" : "text-fg-mut"
            )}
          >
            {route}
          </span>

          <button
            type="button"
            aria-label={`Close ${tabTitle(tab)}`}
            onClick={(event) => {
              event.stopPropagation();
              closeTab(tab.id);
            }}
            className="ml-auto flex-none pl-0.5 text-fg-fnt transition-colors hover:text-fg"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      </TooltipTrigger>

      {/* Exactly what the strip had to drop, at full length. */}
      <TooltipContent side="bottom" align="start" className="max-w-[340px]">
        <p className="text-fg">{route}</p>
        <p className="truncate font-mono">
          {context ?? "no cluster"} / {namespace || ALL_NAMESPACES}
        </p>
        {tab.missing && (
          <p className="mt-0.5">
            This cluster is no longer in the kubeconfig, so the tab cannot be
            made live.
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/** The open segment carries the fill: it is what says which of the two
 *  lists you are looking at while both stay visible. */
function segClass(on: boolean) {
  return cn(
    "inline-flex items-center gap-1.5 rounded px-[5px] py-0.5 transition-colors hover:bg-hover",
    on && "bg-sel hover:bg-sel"
  );
}

function ContextPopover({
  children,
  open,
  onOpenChange,
  onSelect,
  activeContext,
}: {
  children: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (context: string) => void;
  activeContext?: string | null;
}) {
  const contexts = useClusterStore((s) => s.contexts);
  const lastUsed = useClusterRecencyStore((s) => s.lastUsed);

  // The same order the front door uses. Two cluster lists that disagree
  // about which cluster is first is exactly the drift that made them one
  // component in the first place.
  const { recent, rest } = splitByRecency(contexts, lastUsed);
  const ordered = [...recent, ...rest];

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-[244px] p-1">
        <div
          role="listbox"
          aria-label="Cluster"
          className="max-h-[420px] overflow-auto"
        >
          {contexts.length === 0 && (
            <p className="px-[7px] py-2 text-[11px] text-fg-fnt">
              No contexts in the kubeconfig.
            </p>
          )}
          {ordered.map((ctx) => {
            const selected = ctx.name === activeContext;
            return (
              <button
                key={ctx.name}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => onSelect(ctx.name)}
                className={cn(
                  "w-full rounded-[5px] transition-colors hover:bg-hover",
                  selected && "bg-sel"
                )}
              >
                <ClusterRow
                  context={ctx.name}
                  selected={selected}
                  meta={
                    <span className="text-[10px] uppercase tracking-[0.05em]">
                      {providerLabel(detectProvider(ctx.name))}
                    </span>
                  }
                />
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function NamespacePopover({
  children,
  open,
  onOpenChange,
  namespace,
  onSelect,
}: {
  children: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  namespace: string;
  onSelect: (namespace: string) => void;
}) {
  const { namespaces, podCount } = useClusterSummary();
  const [filter, setFilter] = useState("");

  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? namespaces.filter((ns) => ns.name.toLowerCase().includes(needle))
    : namespaces;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) setFilter("");
        onOpenChange(next);
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-[268px] p-0">
        <div className="flex items-center gap-[7px] border-b border-hair px-2.5 py-2 text-fg-fnt">
          <Search className="h-3 w-3 flex-none" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter namespaces…"
            aria-label="Filter namespaces"
            className="w-full bg-transparent text-xs text-fg outline-none placeholder:text-fg-fnt"
          />
        </div>
        <div
          role="listbox"
          aria-label="Namespace"
          className="max-h-[260px] overflow-auto p-1"
        >
          <NamespaceRow
            label="All namespaces"
            selected={namespace === ""}
            podCount={podCount}
            problemCount={0}
            onSelect={() => onSelect("")}
          />
          <div className="my-1 h-px bg-hair" />
          {visible.map((ns) => (
            <NamespaceRow
              key={ns.name}
              label={ns.name}
              mono
              selected={namespace === ns.name}
              podCount={ns.podCount}
              problemCount={ns.problemCount}
              onSelect={() => onSelect(ns.name)}
            />
          ))}
          {visible.length === 0 && (
            <p className="px-[7px] py-2 text-[11px] text-fg-fnt">
              {namespaces.length === 0
                ? "No namespaces visible on this cluster."
                : `Nothing matches "${filter}".`}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function NamespaceRow({
  label,
  mono,
  selected,
  podCount,
  problemCount,
  onSelect,
}: {
  label: string;
  mono?: boolean;
  selected: boolean;
  podCount: number;
  problemCount: number;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className="grid w-full grid-cols-[14px_1fr_auto] items-center gap-[9px] rounded-[5px] px-[7px] py-[5px] text-left text-xs transition-colors hover:bg-hover"
    >
      <span
        className={cn(
          "grid h-[13px] w-[13px] place-items-center rounded-[3px] border",
          selected ? "border-info bg-info" : "border-fg-fnt"
        )}
      >
        {selected && (
          <Check className="h-[9px] w-[9px] text-canvas" strokeWidth={4} />
        )}
      </span>
      <span
        className={cn("truncate", mono && "font-mono", selected && "text-fg")}
      >
        {label}
      </span>
      <span
        className={cn(
          "font-mono text-[11px]",
          problemCount > 0 ? "text-err" : "text-fg-fnt"
        )}
      >
        {problemCount > 0 ? `${podCount} · ${problemCount} bad` : podCount}
      </span>
    </button>
  );
}
