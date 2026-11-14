import { useCallback, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Maximize } from "lucide-react";

import { ConnectClusterEmptyState } from "@/components/ui/connect-cluster-empty-state";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { SectionHeader } from "@/components/ui/section";
import type { FlowEnd } from "@/generated/types";
import { useCrdIndex } from "@/hooks/useCrdIndex";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { usePeek } from "@/hooks/usePeek";
import { useAppSearch, useSetSearch } from "@/hooks/useSearchParam";
import { useTraffic, type TrafficState } from "@/hooks/useTraffic";
import { parts } from "@/i18n/parts";
import { useT } from "@/i18n/useT";
import { crdInGroup, objectLink, pageLink } from "@/lib/links";
import {
  FLOW_WINDOWS,
  MAX_FLOW_ROWS,
  windowOf,
  type FlowRow,
  type FlowSource,
  type TrafficReading,
} from "@/lib/traffic";
import { cn } from "@/lib/utils";
import { useClusterStore } from "@/stores/clusterStore";
import { UnreadNamespaces } from "../-list/UnreadNamespaces";
import {
  GraphCanvas,
  type GraphCanvasHandle,
  type GraphEdge,
  type GraphNode,
} from "../-map/GraphCanvas";
import { useTopology } from "../-map/useTopology";
import { newMemo } from "../-topology/model";
import { toneOf } from "../-topology/tone";
import { COLLAPSE_ABOVE } from "../-topology/Topology";
import { flowColumns } from "./columns";
import { FlowPanel } from "./FlowPanel";
import { trafficModel } from "./model";
import { SourceRail } from "./SourceRail";
import { WINDOW_WORD } from "./traffic-words";

/** Who talks to whom, from the series a connected Prometheus holds. */
export function Traffic() {
  const t = useT();
  const { isConnected, currentContext } = useClusterStore();
  const scope = useNamespaceScope();
  if (!isConnected)
    return <ConnectClusterEmptyState resourceLabel={t("nav", "traffic")} />;
  return (
    <TrafficScreen
      key={`${currentContext ?? ""}\u0000${scope.wire?.join(",") ?? ""}`}
    />
  );
}

function TrafficScreen() {
  const t = useT();
  const scope = useNamespaceScope();
  const search = useAppSearch();
  const setSearch = useSetSearch();
  const window = windowOf(search.range);
  const state = useTraffic({ scope: scope.wire, window, refresh: "scraped" });
  const windowWords = t("traffic", WINDOW_WORD[window]);

  return (
    <div className="flex h-full flex-col gap-2">
      <SectionHeader
        title={t("traffic", "title")}
        count={
          state.says === "read"
            ? `${t("count", "flows", { n: state.rows.length })} · ${windowWords}`
            : windowWords
        }
        actions={
          <div className="flex items-center rounded-md border border-hair p-0.5 text-[11px]">
            {FLOW_WINDOWS.map((each) => (
              <button
                key={each}
                type="button"
                aria-pressed={window === each}
                className={cn(
                  "rounded-[4px] px-2 py-0.5",
                  window === each
                    ? "bg-sel text-fg"
                    : "text-fg-mut hover:text-fg"
                )}
                onClick={() =>
                  setSearch(
                    { range: each === "5m" ? undefined : each },
                    { replace: true }
                  )
                }
              >
                {each}
              </button>
            ))}
          </div>
        }
      />
      {state.says === "read" ? (
        <TrafficMap
          state={state}
          scope={scope.wire}
          scopeWords={scope.inWords}
          windowWords={windowWords}
        />
      ) : (
        <Stopped state={state} />
      )}
    </div>
  );
}

/** Every state but a reading: the sentence, and the sources where there are any. */
export function Stopped({
  state,
}: {
  state: Exclude<TrafficState, { says: "read" }>;
}) {
  const t = useT();
  const sentence = (() => {
    switch (state.says) {
      case "absent":
        return parts(t("traffic", "absent"), {
          integrations: (
            <Link
              {...pageLink("integrations")}
              className="text-info hover:underline"
            >
              {t("traffic", "integrationsLink")}
            </Link>
          ),
        });
      case "checking":
        return t("traffic", "checking");
      case "unreachable":
        return t("traffic", "unreachable", {
          endpoint: state.endpoint,
          reason: state.reason,
        });
      case "looking":
        return t("traffic", "looking", { endpoint: state.endpoint });
      case "noSource":
        return t("traffic", "noSource", { endpoint: state.endpoint });
      case "reading":
        return t("traffic", "reading", { endpoint: state.endpoint });
      case "failed":
        return t("traffic", "failed", {
          endpoint: state.endpoint,
          said: state.said,
        });
    }
  })();
  const sources: readonly FlowSource[] =
    "sources" in state ? state.sources : [];
  return (
    <div className="flex min-h-0 flex-1 gap-2" data-testid="traffic-stopped">
      {sources.length > 0 && <SourceRail sources={sources} reading={null} />}
      <div className="max-w-[72ch] px-1 py-4 text-xs text-fg-mut">
        <p
          className={cn(
            (state.says === "unreachable" || state.says === "failed") &&
              "text-err"
          )}
        >
          {sentence}
        </p>
        {state.says === "absent" && (
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-4">
            {(
              ["needIstio", "needHubble", "needBeyla", "needCaretta"] as const
            ).map((need) => (
              <li key={need}>{t("traffic", need)}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TrafficMap({
  state,
  scope,
  scopeWords,
  windowWords,
}: {
  state: Extract<TrafficState, { says: "read" }>;
  scope: string[] | null;
  scopeWords: string;
  windowWords: string;
}) {
  const t = useT();
  const navigate = useNavigate();
  const { open: peek } = usePeek();
  const { crdFor } = useCrdIndex();
  const search = useAppSearch();
  const canvas = useRef<GraphCanvasHandle>(null);
  const map = useTopology(scope);
  const { reading, rows, sources } = state;
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(
    new Map()
  );
  const [opened, setOpened] = useState<string | null>(null);

  const stale = useMemo(
    () =>
      new Set(
        map.kinds
          .filter((kind) => kind.reading.says === "stale")
          .map((kind) => kind.kind)
      ),
    [map.kinds]
  );
  const memo = useMemo(
    () => ({ for: [t, stale], drawn: newMemo() }),
    [t, stale]
  ).drawn;
  const several = scope === null || scope.length > 1;
  const model = useMemo(
    () =>
      trafficModel({
        rows,
        nodes: map.nodes,
        reads: map.reads,
        toggled,
        collapsedAtFirst: several && rows.length * 2 > COLLAPSE_ABOVE,
        toneOf: (node) => toneOf(node, { t, ingress: () => null, stale }),
        t,
        memo,
      }),
    [rows, map.nodes, map.reads, toggled, several, t, stale, memo]
  );

  const query = (search.q ?? "").trim().toLowerCase();
  const matches = useMemo(
    () =>
      query
        ? new Set(
            model.nodes
              .filter((node) => node.label.toLowerCase().includes(query))
              .map((node) => node.id)
          )
        : null,
    [model.nodes, query]
  );

  const openEnd = useCallback(
    (end: FlowEnd, how: "peek" | "page") => {
      const object =
        end.is === "workload"
          ? {
              kind: end.key.kind,
              name: end.key.name,
              namespace: end.key.namespace,
              crd: crdInGroup(end.key, crdFor) ?? undefined,
            }
          : end.is === "service" && end.namespace
            ? { kind: "Service", name: end.name, namespace: end.namespace }
            : null;
      if (!object) return;
      const link = objectLink(object);
      if (!link) return;
      if (how === "page") void navigate(link);
      else peek(object);
    },
    [navigate, peek, crdFor]
  );
  const onOpen = useCallback(
    (node: GraphNode, how: "peek" | "page") => {
      const end = model.endOf.get(node.id);
      if (end) openEnd(end, how);
    },
    [model.endOf, openEnd]
  );
  const onOpenEdge = useCallback(
    (edge: GraphEdge) => setOpened(model.rowOf.get(edge.id)?.id ?? null),
    [model.rowOf]
  );
  const onToggleGroup = useCallback(
    (id: string) =>
      setToggled((was) => {
        const group = model.groups.find((each) => each.id === id);
        return new Map(was).set(id, !(group?.collapsed ?? false));
      }),
    [model.groups]
  );
  const columns = useMemo(() => flowColumns(t), [t]);
  const openRow = rows.find((row) => row.id === opened) ?? null;

  const notes = notesOf(reading, sources, t);
  const quiet = rows.length === 0;

  return (
    <>
      {(notes.length > 0 || state.lastFailed !== null) && (
        <div className="flex flex-col gap-0.5 px-1 text-[11.5px]">
          {state.lastFailed !== null && (
            <p className="text-err">
              {t("traffic", "lastFailed", { said: state.lastFailed })}
            </p>
          )}
          {notes.map((note) => (
            <p key={note} className="text-warn">
              {note}
            </p>
          ))}
        </div>
      )}
      <UnreadNamespaces
        unread={reading.answer.podsUnread}
        label={t("traffic", "podsLabel")}
      />
      <div className="flex min-h-0 flex-1 gap-2">
        <SourceRail sources={sources} reading={reading} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <div className="relative min-h-0 flex-[3] overflow-hidden rounded-lg border border-hair">
            <GraphCanvas
              ref={canvas}
              groups={model.groups}
              nodes={model.nodes}
              edges={model.edges}
              onToggleGroup={onToggleGroup}
              onOpen={onOpen}
              onOpenEdge={onOpenEdge}
              highlight={matches}
              ariaLabel={t("traffic", "canvasLabel")}
            />
            <Button
              variant="ghost"
              size="sm"
              className="absolute bottom-2 left-2"
              onClick={() => canvas.current?.fit()}
              aria-label={t("traffic", "fit")}
            >
              <Maximize className="h-3.5 w-3.5" aria-hidden />
            </Button>
            {quiet && (
              <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-fg-mut">
                {t("traffic", "nothingInWindow", {
                  sources: reading.sources.map((each) => each.name).join(", "),
                  scope: scopeWords,
                  window: windowWords,
                })}
              </p>
            )}
            {openRow && (
              <FlowPanel
                row={openRow}
                window={windowWords}
                onClose={() => setOpened(null)}
              />
            )}
          </div>
          <div className="flex min-h-0 flex-[2] flex-col">
            <DataTable
              columns={columns}
              data={rows as FlowRow[]}
              fill
              searchParam="q"
              searchPlaceholder={t("traffic", "searchPlaceholder")}
              getRowId={(row) => row.id}
              onRowClick={(row) => setOpened(row.id)}
              partial={reading.answer.cut > 0}
              share={{
                title: t("traffic", "title"),
                partial: partialOf(reading, sources, t),
              }}
              emptyMessage={t("traffic", "nothingInWindow", {
                sources: reading.sources.map((each) => each.name).join(", "),
                scope: scopeWords,
                window: windowWords,
              })}
              widthsKey="traffic-flows"
            />
          </div>
        </div>
      </div>
    </>
  );
}

/** What is not whole about this reading, said above it and in the file. */
function notesOf(
  reading: TrafficReading,
  sources: readonly FlowSource[],
  t: ReturnType<typeof useT>
): string[] {
  const out: string[] = [];
  if (reading.answer.cut > 0)
    out.push(
      t("traffic", "cut", {
        kept: t("count", "flows", { n: MAX_FLOW_ROWS }),
        cut: t("count", "flows", { n: reading.answer.cut }),
      })
    );
  if (reading.answer.podsFailed)
    out.push(
      t("traffic", "podsFailed", { said: reading.answer.podsFailed.message })
    );
  for (const source of sources)
    if (source.state.says === "failed")
      out.push(
        t("traffic", "sourceFailed", {
          source: source.name,
          said: source.state.said,
        })
      );
  return out;
}

function partialOf(
  reading: TrafficReading,
  sources: readonly FlowSource[],
  t: ReturnType<typeof useT>
): string | null {
  const failed = reading.answer.reads
    .filter((read) => read.state.says === "failed")
    .map((read) => reading.sources[read.source]?.name ?? "");
  const words = [
    ...notesOf(reading, sources, t),
    ...[...new Set(failed)].map((source) =>
      t("traffic", "sourcePartly", { source })
    ),
  ];
  return words.length > 0 ? words.join(" ") : null;
}
