import { useEffect, useState } from "react";
import { Check, Search } from "lucide-react";

import { Kbd } from "@/components/ui/kbd";
import { ProviderMark } from "@/components/ui/provider-mark";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useClusterSummary } from "@/hooks/useClusterSummary";
import {
  clusterColor,
  detectProvider,
  providerLabel,
} from "@/lib/cluster-identity";
import { cn } from "@/lib/utils";
import { useClusterStore } from "@/stores/clusterStore";
import { useScopeTabStore, type ScopeTab } from "@/stores/scopeTabStore";

const ALL_NAMESPACES = "all namespaces";

/**
 * The window's scope strip. A tab is one cluster plus one namespace, and
 * the two are separate click targets: namespaces change dozens of times
 * an hour and clusters a few times a day, so a single merged list would
 * bury the frequent job under the rare one.
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
  const openTab = useScopeTabStore((s) => s.openTab);

  const [newTabOpen, setNewTabOpen] = useState(false);

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

  return (
    <div className="flex h-[38px] flex-none items-center gap-1 border-b border-hair px-2.5">
      <ContextPopover
        open={newTabOpen}
        onOpenChange={setNewTabOpen}
        onSelect={(context) => {
          setNewTabOpen(false);
          openTab(context);
        }}
      >
        <button
          type="button"
          aria-label="Open another cluster"
          className="rounded-md px-[7px] py-[3px] text-[12px] leading-[15px] text-fg-fnt transition-colors hover:bg-hover hover:text-fg"
        >
          +
        </button>
      </ContextPopover>

      <div
        role="tablist"
        aria-label="Open scopes"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden"
      >
        {tabs.map((tab) => (
          <ScopeTabItem
            key={tab.id}
            tab={tab}
            active={tab.id === activeId}
            context={tab.id === activeId ? currentContext : tab.context}
            namespace={tab.id === activeId ? currentNamespace : tab.namespace}
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

function ScopeTabItem({
  tab,
  active,
  context,
  namespace,
}: {
  tab: ScopeTab;
  active: boolean;
  context: string | null;
  namespace: string;
}) {
  const switchContext = useClusterStore((s) => s.switchContext);
  const switchNamespace = useClusterStore((s) => s.switchNamespace);
  const connect = useClusterStore((s) => s.connect);
  const activateTab = useScopeTabStore((s) => s.activateTab);
  const closeTab = useScopeTabStore((s) => s.closeTab);

  const [open, setOpen] = useState<"ctx" | "ns" | null>(null);
  const color = clusterColor(context);

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

  return (
    <div
      role="tab"
      aria-selected={active}
      className={cn(
        "flex min-w-0 items-center gap-[7px] rounded-md px-[9px] py-1 text-[12px] leading-[15px] transition-colors",
        active ? "bg-sel text-fg" : "text-fg-mut hover:bg-hover"
      )}
    >
      <ContextPopover
        open={open === "ctx"}
        onOpenChange={guard("ctx")}
        activeContext={context}
        onSelect={(next) => {
          setOpen(null);
          if (next === context) return;
          switchContext(next);
          connect(next);
        }}
      >
        <button type="button" className={segClass(open === "ctx")}>
          {/* Only the dot carries the cluster colour here — the mark
              stays at text contrast so the tab reads as one label and
              the colour signal has a single owner. */}
          <span
            className="h-1.5 w-1.5 flex-none rounded-full"
            style={{ background: color }}
          />
          <ProviderMark
            provider={detectProvider(context ?? "")}
            className="h-[13px] w-[13px]"
          />
          <span className="whitespace-nowrap">{context ?? "no cluster"}</span>
        </button>
      </ContextPopover>

      <span className="mx-px text-fg-fnt">/</span>

      <NamespacePopover
        open={open === "ns"}
        onOpenChange={guard("ns")}
        namespace={namespace}
        onSelect={(next) => {
          setOpen(null);
          switchNamespace(next);
        }}
      >
        <button type="button" className={segClass(open === "ns")}>
          <span className="whitespace-nowrap">
            {namespace || ALL_NAMESPACES}
          </span>
          <span className="text-[9px] text-fg-fnt">▾</span>
        </button>
      </NamespacePopover>

      <button
        type="button"
        aria-label={`Close ${context ?? "scope"}`}
        onClick={() => closeTab(tab.id)}
        className="flex-none text-fg-fnt transition-colors hover:text-fg"
      >
        <span aria-hidden="true">✕</span>
      </button>
    </div>
  );
}

/** The open segment carries the fill: it is what says which of the two
 *  lists you are looking at while both stay visible. */
function segClass(on: boolean) {
  return cn(
    "inline-flex min-w-0 items-center gap-1.5 rounded px-[5px] py-0.5 transition-colors hover:bg-hover",
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
          {contexts.map((ctx) => {
            const selected = ctx.name === activeContext;
            const color = clusterColor(ctx.name);
            const provider = detectProvider(ctx.name);
            return (
              <button
                key={ctx.name}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => onSelect(ctx.name)}
                className={cn(
                  "grid w-full grid-cols-[6px_1fr_auto] items-center gap-[9px] rounded-[5px] px-[7px] py-[5px] text-left text-xs transition-colors hover:bg-hover",
                  selected && "bg-sel"
                )}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: color }}
                />
                <span className="flex items-center gap-[7px] overflow-hidden">
                  <ProviderMark provider={provider} style={{ color }} />
                  <span
                    className={cn(
                      "truncate font-mono",
                      selected ? "text-fg" : "text-fg-mid"
                    )}
                  >
                    {ctx.name}
                  </span>
                </span>
                <span className="text-[10px] uppercase tracking-[0.05em] text-fg-fnt">
                  {providerLabel(provider)}
                </span>
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
