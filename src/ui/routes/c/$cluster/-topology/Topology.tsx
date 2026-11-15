import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Download, Maximize, Search } from "lucide-react";

import { ConnectClusterEmptyState } from "@/components/ui/connect-cluster-empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionHeader } from "@/components/ui/section";
import { useToast } from "@/components/ui/use-toast";
import { ShareScreenAction } from "@/components/share/ShareAction";
import { useShareSection } from "@/components/share/screen-share";
import type { TopologyNode } from "@/generated/types";
import { useCrdIndex } from "@/hooks/useCrdIndex";
import { useIngressHealth } from "@/hooks/useIngressHealth";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { usePeek } from "@/hooks/usePeek";
import { useAppSearch, useSetSearch } from "@/hooks/useSearchParam";
import { useServiceHealthInputs } from "@/hooks/useServiceHealthInputs";
import { useT } from "@/i18n/useT";
import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import { shownPath } from "@/lib/hide-paths";
import { pickSavePath } from "@/lib/host";
import { crdInGroup, objectLink } from "@/lib/links";
import { toastError } from "@/lib/toast-error";
import { cn } from "@/lib/utils";
import { useClusterStore } from "@/stores/clusterStore";
import {
  GraphCanvas,
  type GraphCanvasHandle,
  type GraphNode,
} from "../-map/GraphCanvas";
import { useTopology } from "../-map/useTopology";
import { KindRail, type RailRow } from "./KindRail";
import {
  HIDDEN_AT_FIRST,
  MAP_KINDS,
  OWNERLESS,
  countOf,
  modelOf,
  newMemo,
  notLookedAt,
  readingOf,
  type Grouping,
} from "./model";
import { toneOf, type ToneInputs } from "./tone";
import { topologySection } from "./topology-share";
import { useVendorLayers } from "./vendor-layers";

/** Past this many nodes in a scope of several namespaces, every group starts collapsed. */
export const COLLAPSE_ABOVE = 400;

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** The cluster on one map: every namespace in scope as a group, what is in it, and how it connects. */
export function Topology() {
  const t = useT();
  const { isConnected, currentContext } = useClusterStore();
  const scope = useNamespaceScope();
  if (!isConnected) {
    return <ConnectClusterEmptyState resourceLabel={t("nav", "topology")} />;
  }
  // What the reader opened, closed and searched belongs to one cluster and
  // one scope: another is a map of its own.
  return (
    <TopologyMap
      key={`${currentContext ?? ""}\u0000${scope.wire?.join(",") ?? ""}`}
    />
  );
}

function TopologyMap() {
  const t = useT();
  const { currentContext } = useClusterStore();
  const scope = useNamespaceScope();
  const search = useAppSearch();
  const setSearch = useSetSearch();
  const navigate = useNavigate();
  const { open: peek } = usePeek();
  const { crdFor } = useCrdIndex();
  const { toast } = useToast();
  const canvas = useRef<GraphCanvasHandle>(null);
  const searchBox = useRef<HTMLInputElement>(null);

  const grouping: Grouping = search.view === "app" ? "app" : "namespace";
  const policies = search.policies === "on";
  const [hidden, setHidden] = useState<ReadonlySet<string>>(HIDDEN_AT_FIRST);
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(
    new Map()
  );
  const [query, setQuery] = useState(search.q ?? "");
  const [focus, setFocus] = useState<string | null>(null);

  const map = useTopology(scope.wire);

  const ingressRows = useMemo(
    () =>
      [...map.nodes.values()].flatMap((node) =>
        node.verdict.says === "ingress" ? [node.verdict.row] : []
      ),
    [map]
  );
  const reading = ingressRows.length > 0;
  const backing = useServiceHealthInputs(scope.wire, { enabled: reading });
  const ingressHealth = useIngressHealth(ingressRows, backing, {
    enabled: reading,
  });
  const stale = useMemo(
    () =>
      new Set(
        map.kinds
          .filter((kind) => kind.reading.says === "stale")
          .map((kind) => kind.kind)
      ),
    [map.kinds]
  );
  const toneInputs = useMemo<ToneInputs>(
    () => ({ t, ingress: (row) => ingressHealth(row), stale }),
    [t, ingressHealth, stale]
  );

  const several = scope.wire === null || scope.wire.length > 1;
  // What each object was drawn as, kept while nothing that decides it moves.
  const memo = useMemo(
    () => ({ for: [toneInputs, t, policies, grouping], drawn: newMemo() }),
    [toneInputs, t, policies, grouping]
  ).drawn;
  const collapsedAtFirst =
    several && (map.phase !== "ready" || map.nodes.size > COLLAPSE_ABOVE);
  const model = useMemo(
    () =>
      modelOf(
        map.nodes,
        map.edges,
        map.reads,
        { grouping, hidden, policies, toggled, collapsedAtFirst },
        (node) => toneOf(node, toneInputs),
        t,
        memo
      ),
    [
      map,
      grouping,
      hidden,
      policies,
      toggled,
      collapsedAtFirst,
      toneInputs,
      t,
      memo,
    ]
  );

  const openServices = useMemo(() => {
    const open = new Set(
      model.groups.filter((group) => !group.collapsed).map((group) => group.id)
    );
    return model.nodes
      .filter(
        (node) =>
          node.kind === "Service" && node.group !== null && open.has(node.group)
      )
      .flatMap((node) => {
        const held = map.nodes.get(node.id);
        return held?.ref.namespace
          ? [{ namespace: held.ref.namespace, name: held.ref.name }]
          : [];
      });
  }, [model, map]);
  const groupIds = useMemo(
    () => new Set(model.groups.map((group) => group.id)),
    [model.groups]
  );
  const vendorGroup = useCallback(
    (namespace: string) =>
      grouping === "namespace" && groupIds.has(namespace) ? namespace : null,
    [grouping, groupIds]
  );
  const whole = map.phase === "ready" || map.phase === "ended";
  const vendor = useVendorLayers(
    map.nodes,
    openServices,
    vendorGroup,
    t,
    whole
  );
  const shownVendor = vendor.nodes.filter(
    (each) => !hidden.has(each.node.kind)
  );
  const allNodes = [...model.nodes, ...shownVendor.map((each) => each.node)];
  const allEdges = [...model.edges, ...vendor.edges];

  // Read every render: the vendor layers are, and this is one pass over memory.
  const matches = (() => {
    const asked = query.trim().toLowerCase();
    if (!asked) return null;
    return new Set(
      allNodes
        .filter(
          (node) =>
            node.label.toLowerCase().includes(asked) ||
            node.kind.toLowerCase() === asked
        )
        .map((node) => node.id)
    );
  })();

  const goTo = useCallback(
    (id: string) => {
      const group = model.groupOf.get(id);
      if (group && model.groups.find((each) => each.id === group)?.collapsed)
        setToggled((was) => new Map(was).set(group, false));
      setFocus(id);
    },
    [model]
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || typing(event.target)) return;
      event.preventDefault();
      searchBox.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const crdOf = useCallback(
    (node: TopologyNode) =>
      node.ref.group === undefined
        ? undefined
        : crdInGroup({ kind: node.ref.kind, group: node.ref.group }, crdFor),
    [crdFor]
  );

  const onOpen = useCallback(
    (drawn: GraphNode, how: "peek" | "page") => {
      const added = vendor.nodes.find((each) => each.node.id === drawn.id);
      if (added) {
        if (how === "peek" && added.peek) peek(added.peek);
        else if (added.page) void navigate(added.page);
        return;
      }
      const node = map.nodes.get(drawn.id);
      if (!node || node.ref.name === OWNERLESS) return;
      const object = {
        kind: node.ref.kind,
        name: node.ref.name,
        namespace: node.ref.namespace ?? null,
        crd: crdOf(node) ?? undefined,
      };
      const link = objectLink(object);
      if (!link) return;
      if (how === "page") void navigate(link);
      else peek(object);
    },
    [map.nodes, vendor.nodes, crdOf, navigate, peek]
  );

  const onToggleGroup = useCallback(
    (id: string) =>
      setToggled((was) => {
        const now = new Map(was);
        const group = model.groups.find((each) => each.id === id);
        now.set(id, !(group?.collapsed ?? collapsedAtFirst));
        return now;
      }),
    [model.groups, collapsedAtFirst]
  );

  const vendorKinds = [
    ...new Set(vendor.nodes.map((each) => each.node.kind)),
  ].filter((kind) => !(MAP_KINDS as readonly string[]).includes(kind));
  const mapRail = useMemo(
    () =>
      MAP_KINDS.map((kind) => {
        const { count, used } = countOf(kind, map.reads, map.nodes);
        return {
          kind,
          count,
          used,
          reading: readingOf(kind, map.kinds),
          hidden: hidden.has(kind) || (kind === "NetworkPolicy" && !policies),
        };
      }),
    [map.reads, map.nodes, map.kinds, hidden, policies]
  );
  const rail: RailRow[] = [
    ...mapRail,
    ...vendorKinds.map((kind) => ({
      kind,
      count: vendor.nodes.filter((each) => each.node.kind === kind).length,
      used: null,
      reading: null,
      hidden: hidden.has(kind),
    })),
  ];

  const notLooked = useMemo(() => notLookedAt(map.kinds, t), [map.kinds, t]);
  const syncing = map.kinds.filter(
    (kind) => kind.reading.says === "syncing" || kind.reading.says === "queued"
  );

  const others = useMemo(() => {
    if (!policies) return [];
    const kinds = new Set<string>();
    for (const node of map.nodes.values())
      if (node.cover?.says === "unknown")
        for (const kind of node.cover.kinds) kinds.add(kind);
    return [...kinds];
  }, [map, policies]);

  const caption = [
    grouping === "app"
      ? t("topology", "groupApp")
      : t("topology", "groupNamespace"),
    hidden.size > 0 &&
      t("topology", "hiddenKinds", { kinds: [...hidden].join(", ") }),
  ]
    .filter(Boolean)
    .join(" · ");
  useShareSection("topology", () =>
    topologySection(
      model,
      notLooked.map((entry) => entry.kind),
      t,
      caption
    )
  );

  const exportImage = async () => {
    const svg = canvas.current?.toSvg();
    if (!svg) return;
    try {
      const destination = await pickSavePath({
        defaultPath: `topology-${currentContext ?? "cluster"}.svg`,
      });
      if (!destination) return;
      await commands.writeTextFile(destination, svg);
      toast({
        title: t("topology", "exported", { path: shownPath(destination) }),
      });
    } catch (error) {
      toastError(t("topology", "exportFailed"), error);
    }
  };

  const drawnNamespaces = map.reads.size;
  const nothing =
    map.phase === "ready" &&
    model.nodes.length === 0 &&
    notLooked.length === 0 &&
    syncing.length === 0;

  return (
    <div className="flex h-full flex-col gap-2">
      <SectionHeader
        title={t("topology", "title")}
        count={
          map.phase === "ready"
            ? `${t("count", "mapObjects", { n: model.nodes.length })} · ${t("count", "mapGroups", { n: model.groups.length })}`
            : t("count", "namespacesDrawn", { n: drawnNamespaces })
        }
        actions={
          <>
            <div className="flex items-center rounded-md border border-hair p-0.5 text-[11px]">
              {(["namespace", "app"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={grouping === mode}
                  className={cn(
                    "rounded-[4px] px-2 py-0.5",
                    grouping === mode
                      ? "bg-sel text-fg"
                      : "text-fg-mut hover:text-fg"
                  )}
                  onClick={() =>
                    setSearch(
                      { view: mode === "app" ? "app" : undefined },
                      { replace: true }
                    )
                  }
                >
                  {mode === "app"
                    ? t("topology", "groupApp")
                    : t("topology", "groupNamespace")}
                </button>
              ))}
            </div>
            <Button
              variant={policies ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={policies}
              onClick={() =>
                setSearch(
                  { policies: policies ? undefined : "on" },
                  { replace: true }
                )
              }
            >
              {t("topology", "policies")}
            </Button>
            <label className="relative flex items-center">
              <Search
                className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-fg-fnt"
                aria-hidden
              />
              <Input
                ref={searchBox}
                value={query}
                placeholder={t("topology", "searchPlaceholder")}
                aria-label={t("topology", "searchPlaceholder")}
                className="h-7 w-52 pl-7 text-xs"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setQuery("");
                  if (event.key === "Enter" && matches && matches.size > 0)
                    goTo([...matches][0]);
                }}
              />
            </label>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => canvas.current?.fit()}
              aria-label={t("topology", "fit")}
            >
              <Maximize className="h-3.5 w-3.5" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void exportImage()}
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              {t("topology", "exportImage")}
            </Button>
            <ShareScreenAction
              screen={{ title: t("topology", "title"), scope: scope.scope }}
            />
          </>
        }
      />
      {(notLooked.length > 0 ||
        others.length > 0 ||
        vendor.unread.length > 0 ||
        matches !== null ||
        map.error !== null) && (
        <div
          className="flex flex-col gap-0.5 px-1 text-[11.5px]"
          data-testid="topology-not-read"
        >
          {map.error !== null && (
            <p className="text-err">
              {t("topology", "failed", { said: errorToShow(map.error) })}
            </p>
          )}
          {notLooked.length > 0 && (
            <p className="text-warn">
              {t("topology", "notLookedAt", {
                kinds: notLooked.map((entry) => entry.line).join("; "),
              })}
            </p>
          )}
          {notLooked
            .filter((entry) => entry.edges)
            .map((entry) => (
              <p key={entry.kind} className="text-fg-mut">
                {t("topology", "edgesAbsent", { kind: entry.kind })}
              </p>
            ))}
          {vendor.unread.map((line) => (
            <p key={line} className="text-warn">
              {line}
            </p>
          ))}
          {others.length > 0 && (
            <p className="text-fg-mut">
              {t("topology", "otherEngines", { kinds: others.join(", ") })}
            </p>
          )}
          {matches !== null && (
            <p className="text-fg-mut">
              {matches.size > 0
                ? t("count", "foundOnMap", { n: matches.size })
                : t("topology", "noMatch")}
            </p>
          )}
        </div>
      )}
      <div className="flex min-h-0 flex-1 gap-2">
        <KindRail
          rows={rail}
          onToggle={(kind) => {
            if (kind === "NetworkPolicy" && !policies) {
              setSearch({ policies: "on" }, { replace: true });
              return;
            }
            setHidden((was) => {
              const now = new Set(was);
              if (now.has(kind)) now.delete(kind);
              else now.add(kind);
              return now;
            });
          }}
        />
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-hair">
          <GraphCanvas
            ref={canvas}
            groups={model.groups}
            nodes={allNodes}
            edges={allEdges}
            onToggleGroup={onToggleGroup}
            onOpen={onOpen}
            highlight={matches}
            focus={focus}
            fitKey={`${grouping}${whole ? "\u0000whole" : ""}`}
            ariaLabel={t("topology", "canvasLabel")}
            summaryText={(group) => model.summaries.get(group.id) ?? ""}
          />
          {(map.phase === "opening" ||
            (syncing.length > 0 && map.phase !== "ended")) && (
            <p className="pointer-events-none absolute left-3 top-3 rounded-md bg-raise/90 px-2 py-1 text-[11.5px] text-fg-mut">
              {syncing.length > 0
                ? t("topology", "stillListing", {
                    kinds: syncing.map((kind) => kind.kind).join(", "),
                  })
                : t("count", "namespacesDrawn", { n: drawnNamespaces })}
            </p>
          )}
          {nothing && (
            <p className="absolute inset-0 flex items-center justify-center text-sm text-fg-mut">
              {t("topology", "nothingToDraw", { scope: scope.inWords })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
