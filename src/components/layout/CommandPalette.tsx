import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useClusterStore } from "@/stores/clusterStore";
import { commands } from "@/lib/commands";
import type {
  ResourceListItem,
  ResourceQuery,
  RecentItem,
} from "@/generated/types";
import { ResourceType, toPlural, getScope } from "@/lib/resource-registry";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { ResourceRef } from "@/components/resources/ResourceRef";
import {
  Box,
  Network,
  Server,
  FileText,
  Settings,
  Activity,
  Package,
  LayoutDashboard,
  Search,
} from "lucide-react";

const quickActions = [
  {
    icon: LayoutDashboard,
    label: "Go to Overview",
    path: "/",
    category: "Navigation",
  },
  {
    icon: Box,
    label: "Go to Pods",
    path: `/workloads/${toPlural(ResourceType.Pod)}`,
    category: "Navigation",
  },
  {
    icon: Box,
    label: "Go to Deployments",
    path: `/workloads/${toPlural(ResourceType.Deployment)}`,
    category: "Navigation",
  },
  {
    icon: Network,
    label: "Go to Services",
    path: `/network/${toPlural(ResourceType.Service)}`,
    category: "Navigation",
  },
  {
    icon: Server,
    label: "Go to Nodes",
    path: `/${toPlural(ResourceType.Node)}`,
    category: "Navigation",
  },
  {
    icon: FileText,
    label: "Go to ConfigMaps",
    path: `/configuration/${toPlural(ResourceType.ConfigMap)}`,
    category: "Navigation",
  },
  {
    icon: FileText,
    label: "Go to Secrets",
    path: `/configuration/${toPlural(ResourceType.Secret)}`,
    category: "Navigation",
  },
  {
    icon: Activity,
    label: "Go to Events",
    path: "/events",
    category: "Navigation",
  },
  { icon: Package, label: "Go to Helm", path: "/helm", category: "Navigation" },
  {
    icon: Settings,
    label: "Go to Settings",
    path: "/settings",
    category: "Navigation",
  },
];

const quickCommands = [
  { icon: Box, label: "Create Pod" },
  { icon: Box, label: "Create Deployment" },
  { icon: Network, label: "Create Service" },
];

interface ResourceResult {
  kind: string;
  name: string;
  namespace?: string;
  path: string;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [resourceResults, setResourceResults] = useState<ResourceResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recentItems, setRecentItems] = useState<RecentItem[]>([]);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const { isConnected, currentNamespace } = useClusterStore();
  const searchValue = searchQuery.trim().toLowerCase();
  const hasQuery = searchValue.length > 0;
  const canSearchResources = searchValue.length >= 2;

  // Global keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const handleOpen = () => {
      setOpen(true);
    };
    window.addEventListener("command-palette-open", handleOpen);
    return () => window.removeEventListener("command-palette-open", handleOpen);
  }, []);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const handleSelect = useCallback(
    (path: string, name?: string, kind?: string, namespace?: string) => {
      if (name && kind) {
        commands
          .addRecentItem({
            name,
            kind,
            path,
            namespace: namespace ?? undefined,
            timestamp: Date.now(),
          })
          .catch(() => {
            // Ignore errors saving recent item
          });
      }
      setOpen(false);
      requestAnimationFrame(() => {
        navigate(path);
      });
    },
    [navigate]
  );

  // Reset palette state on every open/close transition. Genuine
  // sync-prop-into-state — `key`-style remount via parent would be
  // cleaner but the palette is mounted at the app root.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (open) {
      commands
        .getRecentItems()
        .then(setRecentItems)
        .catch(() => {
          setRecentItems([]);
        });
    } else {
      setSearchQuery("");
      setResourceResults([]);
      setIsSearching(false);
      setSelectedIndex(0);
    }
  }, [open]);

  // Debounced search — clear results state while building a new query.
  useEffect(() => {
    if (!open || !isConnected) {
      setResourceResults([]);
      setIsSearching(false);
      return;
    }

    if (searchValue.length < 2) {
      setResourceResults([]);
      setIsSearching(false);
      return;
    }

    let cancelled = false;
    setIsSearching(true);

    const timeoutId = window.setTimeout(async () => {
      try {
        const namespace = currentNamespace || null;
        const searchableKinds = [
          ResourceType.Pod,
          ResourceType.Deployment,
          ResourceType.Service,
          ResourceType.ConfigMap,
          ResourceType.Secret,
          ResourceType.Ingress,
          ResourceType.Node,
        ];

        const results = await Promise.all(
          searchableKinds.map(async (kind) => {
            try {
              const isNamespaced = getScope(kind) === "namespaced";
              const queryParams: ResourceQuery = {
                kind: toPlural(kind),
                limit: 200,
                namespace: isNamespaced ? namespace || null : null,
                name: null,
                labelSelector: null,
                fieldSelector: null,
              };

              const items = await commands.listResources(queryParams);

              if (!items || !Array.isArray(items)) {
                return [] as ResourceResult[];
              }

              return items
                .map((item: ResourceListItem) => {
                  const name = item.metadata.name;
                  const ns = item.metadata.namespace ?? undefined;
                  if (!name) return null;
                  const matches =
                    name.toLowerCase().includes(searchValue) ||
                    (ns && ns.toLowerCase().includes(searchValue));
                  if (!matches) return null;
                  return {
                    kind,
                    name,
                    namespace: ns,
                    path: getResourceDetailUrl(kind, name, ns),
                  };
                })
                .filter(Boolean) as ResourceResult[];
            } catch {
              return [] as ResourceResult[];
            }
          })
        );

        if (!cancelled) {
          setResourceResults(results.flat());
          setIsSearching(false);
        }
      } catch (error) {
        if (!cancelled) {
          console.error("Search failed:", error);
          setResourceResults([]);
          setIsSearching(false);
        }
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [currentNamespace, isConnected, open, searchValue]);

  const groupedResources = useMemo(() => {
    return resourceResults.reduce<Record<string, ResourceResult[]>>(
      (acc, item) => {
        acc[item.kind] = acc[item.kind] || [];
        acc[item.kind].push(item);
        return acc;
      },
      {}
    );
  }, [resourceResults]);

  const filteredNavigation = useMemo(() => {
    const items = quickActions.filter(
      (action) => action.category === "Navigation"
    );
    if (!hasQuery) {
      return items;
    }
    return items.filter((action) =>
      action.label.toLowerCase().includes(searchValue)
    );
  }, [hasQuery, searchValue]);

  const filteredQuickCommands = useMemo(() => {
    if (!hasQuery) {
      return quickCommands;
    }
    return quickCommands.filter((action) =>
      action.label.toLowerCase().includes(searchValue)
    );
  }, [hasQuery, searchValue]);

  const hasResourceResults = canSearchResources && resourceResults.length > 0;
  const hasAnyResults =
    filteredNavigation.length > 0 ||
    filteredQuickCommands.length > 0 ||
    hasResourceResults;

  // Flattened list of all selectable items for keyboard navigation
  const allItems = useMemo(() => {
    const items: Array<{
      type: "recent" | "nav" | "action" | "resource";
      path?: string;
      name?: string;
      kind?: string;
      namespace?: string;
      label?: string;
    }> = [];

    // Recent items (only when no query)
    if (!hasQuery && recentItems.length > 0) {
      recentItems.forEach((item) => {
        items.push({
          type: "recent",
          path: item.path,
          name: item.name,
          kind: item.kind,
          namespace: item.namespace ?? undefined,
        });
      });
    }

    // Navigation items
    filteredNavigation.forEach((action) => {
      items.push({ type: "nav", path: action.path, label: action.label });
    });

    // Quick actions
    filteredQuickCommands.forEach((action) => {
      items.push({ type: "action", label: action.label });
    });

    // Resource results
    resourceResults.forEach((item) => {
      items.push({
        type: "resource",
        path: item.path,
        name: item.name,
        kind: item.kind,
        namespace: item.namespace,
      });
    });

    return items;
  }, [
    hasQuery,
    recentItems,
    filteredNavigation,
    filteredQuickCommands,
    resourceResults,
  ]);

  // Reset selection when items change
  useEffect(() => {
    setSelectedIndex(0);
  }, [allItems.length]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, allItems.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && allItems.length > 0) {
        e.preventDefault();
        const item = allItems[selectedIndex];
        if (item?.path) {
          handleSelect(item.path, item.name, item.kind, item.namespace);
        }
      }
    },
    [allItems, selectedIndex, handleSelect]
  );

  // Scroll selected item into view
  useEffect(() => {
    if (resultsRef.current) {
      const selected = resultsRef.current.querySelector(
        `[data-index="${selectedIndex}"]`
      );
      if (selected) {
        selected.scrollIntoView({ block: "nearest" });
      }
    }
  }, [selectedIndex]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="z-[60] max-w-[560px] gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Command palette</DialogTitle>

        {/* One field on the raised surface. A bordered input inside an
            overlay is a second surface on top of the only surface the
            design allows — the hairline below is the whole chrome. */}
        <div className="flex items-center gap-2 border-b border-hair px-3 py-2.5 text-fg-fnt">
          <Search className="h-3.5 w-3.5 flex-none" />
          <input
            ref={inputRef}
            autoFocus
            aria-label="Search resources, actions and pages"
            placeholder="Search resources, actions, or jump to a page…"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-fnt"
          />
        </div>

        <div
          ref={resultsRef}
          role="listbox"
          aria-label="Results"
          className="max-h-[336px] overflow-y-auto p-1"
        >
          {hasQuery && !hasAnyResults && !isSearching && (
            <p className="px-2 py-6 text-center text-xs text-fg-mut">
              Nothing matches "{searchQuery}".
            </p>
          )}

          {!hasQuery && recentItems.length > 0 && (
            <>
              <GroupCaption>Recent</GroupCaption>
              {recentItems.map((item, idx) => (
                <PaletteRow
                  key={item.path}
                  index={idx}
                  selected={selectedIndex === idx}
                  label={
                    <PaletteRef
                      kind={item.kind}
                      name={item.name}
                      namespace={item.namespace ?? undefined}
                      onSelect={() =>
                        handleSelect(
                          item.path,
                          item.name,
                          item.kind,
                          item.namespace ?? undefined
                        )
                      }
                    />
                  }
                  meta={item.namespace ?? undefined}
                  trailing={item.kind}
                  onSelect={() =>
                    handleSelect(
                      item.path,
                      item.name,
                      item.kind,
                      item.namespace ?? undefined
                    )
                  }
                />
              ))}
            </>
          )}

          {filteredNavigation.length > 0 && (
            <>
              <GroupCaption>Navigation</GroupCaption>
              {filteredNavigation.map((action, idx) => {
                const globalIdx = (!hasQuery ? recentItems.length : 0) + idx;
                return (
                  <PaletteRow
                    key={action.path}
                    index={globalIdx}
                    selected={selectedIndex === globalIdx}
                    icon={action.icon}
                    label={action.label}
                    onSelect={() => handleSelect(action.path)}
                  />
                );
              })}
            </>
          )}

          {filteredQuickCommands.length > 0 && (
            <>
              <GroupCaption>Actions</GroupCaption>
              {filteredQuickCommands.map((action, idx) => {
                const globalIdx =
                  (!hasQuery ? recentItems.length : 0) +
                  filteredNavigation.length +
                  idx;
                return (
                  <PaletteRow
                    key={action.label}
                    index={globalIdx}
                    selected={selectedIndex === globalIdx}
                    icon={action.icon}
                    label={action.label}
                    onSelect={() => setOpen(false)}
                  />
                );
              })}
            </>
          )}

          {hasQuery && (
            <>
              <GroupCaption>Resources</GroupCaption>

              {!isConnected ? (
                <Hint>Connect to a cluster to search resources.</Hint>
              ) : !canSearchResources ? (
                <Hint>Type at least 2 characters to search resources.</Hint>
              ) : isSearching ? (
                <Hint>
                  <Spinner size="sm" className="mr-2" />
                  Searching…
                </Hint>
              ) : resourceResults.length === 0 ? (
                <Hint>No resources found.</Hint>
              ) : (
                (() => {
                  let resourceIdx =
                    (!hasQuery ? recentItems.length : 0) +
                    filteredNavigation.length +
                    filteredQuickCommands.length;
                  return Object.entries(groupedResources).flatMap(
                    ([kind, items]) =>
                      items.map((item) => {
                        const globalIdx = resourceIdx++;
                        return (
                          <PaletteRow
                            key={`${kind}-${item.namespace ?? "cluster"}-${item.name}`}
                            index={globalIdx}
                            selected={selectedIndex === globalIdx}
                            label={
                              <PaletteRef
                                kind={kind}
                                name={item.name}
                                namespace={item.namespace}
                                onSelect={() =>
                                  handleSelect(
                                    item.path,
                                    item.name,
                                    kind,
                                    item.namespace
                                  )
                                }
                              />
                            }
                            meta={item.namespace}
                            trailing={kind}
                            onSelect={() =>
                              handleSelect(
                                item.path,
                                item.name,
                                kind,
                                item.namespace
                              )
                            }
                          />
                        );
                      })
                  );
                })()
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-3.5 border-t border-hair px-3 py-1.5 text-[11px] text-fg-fnt">
          <span className="flex items-center gap-1.5">
            <Kbd shortcut="↑↓" />
            move
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd shortcut="↵" />
            open
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd shortcut="esc" />
            close
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <Kbd shortcut="mod+K" />
            toggle
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 11px group caption — the only thing separating one group from the
 *  next, in place of the rules this list used to draw between them. */
function GroupCaption({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="presentation"
      className="px-2 pb-0.5 pt-2 text-[11px] text-fg-fnt first:pt-1"
    >
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center px-2 py-1.5 text-xs text-fg-mut">
      {children}
    </p>
  );
}

function PaletteRow({
  index,
  selected,
  icon: Icon,
  label,
  meta,
  trailing,
  onSelect,
}: {
  index: number;
  selected: boolean;
  icon?: React.ComponentType<{ className?: string }>;
  label: React.ReactNode;
  meta?: string;
  trailing?: string;
  onSelect: () => void;
}) {
  return (
    // A div, not a button: a resource row names its object with a
    // `ResourceRef`, and an anchor inside a button is not a thing the browser
    // will render. Arrow keys and Enter are handled by the search field.
    <div
      role="option"
      aria-selected={selected}
      data-index={index}
      onClick={onSelect}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded-[5px] px-2 py-[5px] text-left text-xs transition-colors hover:bg-hover",
        selected ? "bg-sel text-fg" : "text-fg-mid"
      )}
    >
      {Icon && <Icon className="h-3.5 w-3.5 flex-none text-fg-fnt" />}
      {/* No `truncate` here: a reference clips its own name, and clipping it
          twice shrinks the row's name to a few characters. */}
      <span className="min-w-0">{label}</span>
      {meta && <span className="truncate text-fg-fnt">{meta}</span>}
      {trailing && (
        <span className="ml-auto flex-none text-[11px] text-fg-fnt">
          {trailing}
        </span>
      )}
    </div>
  );
}

/**
 * A result row's object, as the reference used everywhere else. The row owns
 * the selection, so a plain click on the name is the row's click — but the
 * anchor keeps its href, and a modified click still opens a new window.
 */
function PaletteRef({
  kind,
  name,
  namespace,
  onSelect,
}: {
  kind: string;
  name: string;
  namespace?: string;
  onSelect: () => void;
}) {
  return (
    <ResourceRef
      kind={kind}
      name={name}
      namespace={namespace}
      showKind={false}
      onClick={(event) => {
        event.preventDefault();
        onSelect();
      }}
    />
  );
}
