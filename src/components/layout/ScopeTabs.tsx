import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Search } from "lucide-react";

import { ClusterMenu } from "@/components/cluster/ClusterMenu";
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
import { SCOPE_LIMIT, scopeLabel } from "@/lib/namespace-scope";
import { formatShortcut } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useClusterMark } from "@/stores/clusterIdentityStore";
import {
  splitByRecency,
  useClusterRecencyStore,
} from "@/stores/clusterRecencyStore";
import { useClusterStore } from "@/stores/clusterStore";
import { useT } from "@/i18n/useT";
import {
  tabRouteLabel,
  tabScope,
  tabTitle,
  useScopeTabStore,
  type ScopeTab,
} from "@/stores/scopeTabStore";

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
  const t = useT();
  const currentContext = useClusterStore((s) => s.currentContext);
  const currentNamespace = useClusterStore((s) => s.currentNamespace);
  const namespaceScope = useClusterStore((s) => s.namespaceScope);
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
          ? {
              ...tab,
              context: currentContext,
              namespace: currentNamespace,
              scope: namespaceScope,
            }
          : tab
      ),
    [tabs, activeId, currentContext, currentNamespace, namespaceScope]
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
        aria-label={t("action", "openScopes")}
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
        {t("action", "search")}
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
  const t = useT();
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
              aria-label={t("action", "newTabAria")}
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
            {t("action", "newTabHere")}
            <Kbd shortcut="mod+T" className="leading-[13px]" />
          </p>
          <p className="mt-0.5">{t("action", "rightClickForAnotherCluster")}</p>
        </TooltipContent>
      </Tooltip>

      <ContextMenuContent className="w-[244px]">
        <ContextMenuLabel>{t("action", "newTabOn")}</ContextMenuLabel>
        {contexts.length === 0 && (
          <p className="px-[7px] py-2 text-[11px] text-fg-fnt">
            {t("empty", "noContextsInKubeconfig")}
          </p>
        )}
        {/* The same row the picker and the front door use, so a renamed or
            recoloured cluster is renamed and recoloured here too. */}
        {contexts.map((ctx) => (
          <ContextMenuItem
            key={ctx.name}
            onSelect={() => openTab({ context: ctx.name })}
            className="p-0"
          >
            <ClusterRow context={ctx.name} />
          </ContextMenuItem>
        ))}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => openTab()}>
          {/* Named by what it does rather than by the cluster, because the
              cluster it lands on is whichever one is on screen. */}
          {t("action", "newTabHere")}
          <span className="ml-auto pl-4 text-fg-fnt">
            {currentContext ?? t("cluster", "noCluster")}
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
  const t = useT();
  const { context } = tab;
  const scope = tabScope(tab);
  const switchContext = useClusterStore((s) => s.switchContext);
  const setNamespaceScope = useClusterStore((s) => s.setNamespaceScope);
  const connect = useClusterStore((s) => s.connect);
  const activateTab = useScopeTabStore((s) => s.activateTab);
  const closeTab = useScopeTabStore((s) => s.closeTab);

  const [open, setOpen] = useState<"ctx" | "ns" | null>(null);
  const [tip, setTip] = useState(false);
  const mark = useClusterMark(context);
  const alias = mark.alias?.trim();
  const color = clusterColor(context, mark.hue);
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
            {t("cluster", "chooseCluster")}
          </button>
        </ContextPopover>
        {closable && (
          <button
            type="button"
            aria-label={t("action", "closeTab")}
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
          aria-label={tabTitle(tab, t, alias)}
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
            "flex max-w-104 shrink items-center gap-[5px] overflow-hidden rounded-md px-[9px] py-1 text-[12px] leading-[15px] transition-colors",
            // A lost cluster needs room for the one fact only this tab still
            // holds — the name it was pointed at — and for the word that says
            // it is gone.
            tab.missing ? "min-w-84" : showName ? "min-w-70" : "min-w-54",
            active ? "bg-sel text-fg-mut" : "text-fg-fnt hover:bg-hover"
          )}
        >
          <ContextPopover
            open={open === "ctx"}
            onOpenChange={guard("ctx")}
            activeContext={context}
            onSelect={pickCluster}
          >
            {/* Right, not Down: the strip is walked with Left and Right, but
                this is the one segment where a menu is the point, and Down
                is already spoken for by the `+` beside it. */}
            <ClusterMenu context={context ?? ""} openKeys={["ArrowRight"]}>
              <button
                type="button"
                aria-haspopup="menu"
                className={cn(
                  segClass(open === "ctx"),
                  showName ? "min-w-16 shrink-6" : "flex-none",
                  tab.missing && "min-w-26"
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
                    {alias ?? context ?? t("cluster", "noCluster")}
                  </span>
                )}
              </button>
            </ClusterMenu>
          </ContextPopover>

          {/* Not a suffix on the name but a state of the tab, in the same
              micro-label the context list uses for a provider. The tab
              cannot be made live and nothing about it is going to change
              until the kubeconfig does. */}
          {tab.missing && (
            <span className="flex-none rounded border border-hair px-1 text-[10px] uppercase leading-[13px] tracking-wider text-fg-fnt">
              {t("cluster", "missingBadge")}
            </span>
          )}

          <span aria-hidden="true" className="flex-none text-fg-fnt">
            /
          </span>

          <NamespacePopover
            open={open === "ns"}
            onOpenChange={guard("ns")}
            scope={scope}
            onSelect={(next, keepOpen) => {
              if (!keepOpen) setOpen(null);
              setNamespaceScope(next);
            }}
          >
            <button
              type="button"
              // A floor here as well as on the route: a namespace ground
              // down to a bare chevron is not a shorter label, it is a
              // segment that has stopped saying anything and kept its
              // punctuation.
              className={cn(segClass(open === "ns"), "min-w-14 shrink-6")}
            >
              <span className="min-w-0 truncate">{scopeLabel(scope, t)}</span>
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
              "min-w-18 truncate shrink",
              active ? "text-fg" : "text-fg-mut"
            )}
          >
            {route}
          </span>

          <button
            type="button"
            aria-label={t("action", "closeNamed", {
              name: tabTitle(tab, t, alias),
            })}
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
          {context ?? t("cluster", "noCluster")} / {scopeLabel(scope, t)}
        </p>
        {tab.missing && (
          <p className="mt-0.5">{t("cluster", "missingTabHint")}</p>
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
  const t = useT();
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
          aria-label={t("nav", "cluster")}
          className="max-h-[420px] overflow-auto"
        >
          {contexts.length === 0 && (
            <p className="px-[7px] py-2 text-[11px] text-fg-fnt">
              {t("empty", "noContextsInKubeconfig")}
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
                    <span className="text-[10px] uppercase tracking-wider">
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

/** One row of the namespace list, and everything the row is drawn from. */
interface NamespaceOption {
  /** `""` is "All namespaces", which is the absence of a selection. */
  key: string;
  label: string;
  mono: boolean;
  podCount: number;
  problemCount: number;
  selected: boolean;
  /** The selection is full, so this row can only be opened on its own. */
  closed: boolean;
}

/**
 * One namespace, or several.
 *
 * A plain click *replaces* the selection and shuts the list, because that is
 * what this control has always done and what it is used for dozens of times
 * an hour. Holding the platform's multi-select key toggles instead and leaves
 * the list open, which is the same gesture a file manager and every list in
 * this app's tables already use — so the frequent job costs exactly what it
 * used to and the new one costs a modifier.
 *
 * ## Why the rows are options with nothing inside them
 *
 * A row used to be a `role="option"` holding two buttons, a checkbox and a
 * label. `option` carries *children presentational* in ARIA 1.2: assistive
 * tech is specified to flatten whatever is inside it, so neither button was
 * reachable through it and both their labels folded into one accessible name
 * — including the explanation of why the checkbox had gone quiet at the
 * ceiling, which was also `disabled` and therefore out of the tab order
 * entirely. It cost two tab stops per row as well, which on a sixty-namespace
 * cluster is a hundred and twenty presses to cross the list.
 *
 * So the list is a filtered listbox driven from the filter box — the shape
 * `LogQuery` already uses. The caret never leaves the input, the rows are
 * named by `aria-activedescendant`, and the whole popover is one tab stop.
 * `Enter` replaces the selection and `mod+Enter` toggles: the keyboard
 * spelling of the two gestures the mouse has, rather than a third vocabulary.
 *
 * The checkbox stays a hit target for the mouse, and only for the mouse: a
 * modifier is not an affordance, and somebody who has never held one still
 * has to be able to build a selection by clicking. It is not a control of its
 * own — it cannot be, inside an option — and everything it does the keyboard
 * does with the modifier.
 *
 * Only *adding* stops at `SCOPE_LIMIT`. Replacing the selection with one
 * namespace is always allowed, so the ceiling never gets between a reader and
 * the namespace they are trying to open. The footer is both the filter box's
 * description and a live region, so the ceiling is spoken before it bites and
 * the refusal is spoken when it does.
 */
function NamespacePopover({
  children,
  open,
  onOpenChange,
  scope,
  onSelect,
}: {
  children: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: string[];
  onSelect: (namespaces: string[], keepOpen: boolean) => void;
}) {
  const t = useT();
  const { namespaces, podCount } = useClusterSummary();
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(-1);
  /** The namespace the ceiling has just turned down, until anything else
   *  happens. A refusal nobody is told about is a control that broke. */
  const [refused, setRefused] = useState<string | null>(null);
  const listId = useId();
  const noteId = `${listId}-note`;

  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? namespaces.filter((ns) => ns.name.toLowerCase().includes(needle))
    : namespaces;

  const full = scope.length >= SCOPE_LIMIT;

  // One array, so the cursor is an index into what is actually on screen and
  // "All namespaces" is arrowed onto like any other row.
  const rows: NamespaceOption[] = [
    {
      key: "",
      label: t("cluster", "allNamespaces"),
      mono: false,
      podCount,
      problemCount: 0,
      selected: scope.length === 0,
      closed: false,
    },
    ...visible.map((ns) => ({
      key: ns.name,
      label: ns.name,
      mono: true,
      podCount: ns.podCount,
      problemCount: ns.problemCount,
      selected: scope.includes(ns.name),
      closed: full && !scope.includes(ns.name),
    })),
  ];

  // A cursor left pointing past a list the filter has shortened is not a row.
  const at = cursor < rows.length ? cursor : -1;

  // The caret stays in the input, so the browser will not bring the arrowed
  // row into view. Optional call because jsdom does not implement it.
  useEffect(() => {
    if (at < 0) return;
    document
      .getElementById(`${listId}-${at}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [at, listId]);

  const replace = (row: NamespaceOption) => {
    setRefused(null);
    onSelect(row.key === "" ? [] : [row.key], false);
  };

  const toggle = (row: NamespaceOption) => {
    // "All" is the absence of a selection, so it clears one rather than
    // joining it — there is nothing for it to be added to.
    if (row.key === "") {
      replace(row);
      return;
    }
    if (row.selected) {
      setRefused(null);
      onSelect(
        scope.filter((entry) => entry !== row.key),
        true
      );
      return;
    }
    // Adding past the ceiling refuses and says so. Replacing the selection
    // instead would throw away four namespaces on a gesture that asked to
    // keep them.
    if (full) {
      setRefused(row.key);
      return;
    }
    setRefused(null);
    onSelect([...scope, row.key], true);
  };

  const note = refused
    ? t("cluster", "namespaceLimitRefused", {
        namespace: refused,
        limit: SCOPE_LIMIT,
      })
    : full
      ? t("cluster", "namespaceLimitFull", { n: scope.length })
      : scope.length > 1
        ? t("cluster", "namespaceScopeCount", {
            n: scope.length,
            limit: SCOPE_LIMIT,
          })
        : t("cluster", "namespaceMultiHint", {
            click: formatShortcut("mod"),
            enter: formatShortcut("mod+Enter"),
            limit: SCOPE_LIMIT,
          });

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setFilter("");
          setCursor(-1);
          setRefused(null);
        }
        onOpenChange(next);
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-[268px] p-0">
        <div className="flex items-center gap-[7px] border-b border-hair px-2.5 py-2 text-fg-fnt">
          <Search aria-hidden="true" className="h-3 w-3 flex-none" />
          <input
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setCursor(-1);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                const next = at + step;
                setCursor(next < 0 ? rows.length - 1 : next % rows.length);
                return;
              }
              if (event.key !== "Enter") return;
              // Enter with nothing arrowed onto is the filter's own answer:
              // type three letters, press it, and you are in that namespace —
              // which is the frequent job done without touching the mouse.
              const row =
                at >= 0
                  ? rows[at]
                  : needle !== "" && visible.length > 0
                    ? rows[1]
                    : undefined;
              if (!row) return;
              event.preventDefault();
              if (event.metaKey || event.ctrlKey) toggle(row);
              else replace(row);
            }}
            placeholder={t("action", "filterNamespacesPlaceholder")}
            aria-label={t("action", "filterNamespaces")}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={at >= 0 ? `${listId}-${at}` : undefined}
            aria-describedby={noteId}
            className="w-full bg-transparent text-xs text-fg outline-hidden placeholder:text-fg-fnt"
          />
        </div>
        <div className="max-h-[260px] overflow-auto p-1">
          <div
            id={listId}
            role="listbox"
            aria-label={t("cluster", "namespaces")}
            aria-multiselectable
            // The caret belongs to the filter box for as long as the list is
            // open — it is what names the arrowed row — and a press on a row
            // would take it away. On the list rather than on the scroller, so
            // the scrollbar is still draggable.
            onMouseDown={(event) => event.preventDefault()}
          >
            {rows.map((row, index) => (
              <Fragment key={row.key}>
                <NamespaceRow
                  id={`${listId}-${index}`}
                  row={row}
                  active={index === at}
                  noteId={noteId}
                  onHover={() => setCursor(index)}
                  onReplace={() => replace(row)}
                  onToggle={() => toggle(row)}
                />
                {/* Presentational on purpose: a listbox's children are
                    options, and a bare hairline among them is a child
                    assistive tech has no name for. */}
                {index === 0 && (
                  <div role="presentation" className="my-1 h-px bg-hair" />
                )}
              </Fragment>
            ))}
          </div>
          {/* Outside the listbox, because it is a sentence and not an option
              nobody can pick. */}
          {visible.length === 0 && (
            <p className="px-[7px] py-2 text-[11px] text-fg-fnt">
              {namespaces.length === 0
                ? t("empty", "noNamespacesVisible")
                : t("empty", "nothingMatchesQuery", { query: filter })}
            </p>
          )}
        </div>
        {/* The ceiling is stated as a cost, not as a rule: each namespace
            past the first is a separate reading of the cluster, which is the
            reason there is a number here at all. */}
        <p
          id={noteId}
          aria-live="polite"
          className={cn(
            "border-t border-hair px-2.5 py-1.5 text-[10px] leading-[13px]",
            refused ? "text-warn" : "text-fg-fnt"
          )}
        >
          {note}
        </p>
      </PopoverContent>
    </Popover>
  );
}

function NamespaceRow({
  id,
  row,
  active,
  noteId,
  onHover,
  onReplace,
  onToggle,
}: {
  id: string;
  row: NamespaceOption;
  /** The row the arrows are on, and the one Enter acts on. */
  active: boolean;
  /** The ceiling sentence, pointed at only by the rows it applies to. */
  noteId: string;
  onHover: () => void;
  /** Replace the selection with this one. */
  onReplace: () => void;
  /** Add it to the selection, or take it out. */
  onToggle: () => void;
}) {
  const t = useT();
  const pods = t("cluster", "podCount", { n: row.podCount });
  return (
    <div
      id={id}
      role="option"
      aria-selected={row.selected}
      // Spelled out, because an option's own text reads as "prod 12 · 3 bad".
      aria-label={[
        row.label,
        pods,
        row.problemCount > 0
          ? t("count", "withAProblem", { n: row.problemCount })
          : null,
      ]
        .filter(Boolean)
        .join(", ")}
      // The one thing about the row that cannot be read off the row itself:
      // why its box has gone quiet.
      aria-describedby={row.closed ? noteId : undefined}
      // Hover and the arrows move the same cursor, so there is never a second
      // highlight competing with the one Enter will act on.
      onMouseEnter={onHover}
      onClick={(event) =>
        // The box is a target and the modifier is a gesture; both mean "add".
        event.metaKey ||
        event.ctrlKey ||
        (event.target as HTMLElement).closest("[data-add]") !== null
          ? onToggle()
          : onReplace()
      }
      className={cn(
        "grid w-full cursor-default select-none grid-cols-[14px_1fr_auto] items-center gap-[9px] rounded-[5px] px-[7px] py-[5px] text-left text-xs transition-colors",
        active && "bg-hover",
        row.selected && "text-fg"
      )}
    >
      <span
        data-add
        // The box is 13px and the target around it is not: a checkbox that
        // has to be hit exactly is a checkbox nobody uses twice.
        className="m-[-7px] grid h-[27px] w-[27px] place-items-center"
      >
        <span
          className={cn(
            "grid h-[13px] w-[13px] place-items-center rounded-[3px] border",
            row.selected ? "border-info bg-info" : "border-fg-fnt",
            // Not hidden: the row is still selectable on its own, and a box
            // that vanished would read as a row that cannot be picked at all.
            row.closed && "opacity-40"
          )}
        >
          {row.selected && (
            <Check className="h-[9px] w-[9px] text-canvas" strokeWidth={4} />
          )}
        </span>
      </span>
      <span className={cn("truncate", row.mono && "font-mono")}>
        {row.label}
      </span>
      <span
        className={cn(
          "font-mono text-[11px]",
          row.problemCount > 0 ? "text-err" : "text-fg-fnt"
        )}
      >
        {row.problemCount > 0
          ? `${row.podCount} · ${t("count", "badPods", { n: row.problemCount })}`
          : row.podCount}
      </span>
    </div>
  );
}
