import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Maximize } from "lucide-react";

import { ConnectClusterEmptyState } from "@/components/ui/connect-cluster-empty-state";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { SectionHeader } from "@/components/ui/section";
import type { FlowEnd, UnreadNamespace } from "@/generated/types";
import { useCrdIndex } from "@/hooks/useCrdIndex";
import { useLiveTraffic } from "@/hooks/useLiveTraffic";
import { useCapability } from "@/integrations";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { usePeek } from "@/hooks/usePeek";
import { useAppSearch, useSetSearch } from "@/hooks/useSearchParam";
import { useTraffic, type TrafficState } from "@/hooks/useTraffic";
import { parts } from "@/i18n/parts";
import { useT } from "@/i18n/useT";
import { crdInGroup, objectLink, pageLink } from "@/lib/links";
import {
  FLOW_WINDOWS,
  LIVE_SOURCE,
  LiveRows,
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
import { liveStopped } from "./live-words";
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

type Mode = "window" | "live";

function TrafficScreen() {
  const t = useT();
  const scope = useNamespaceScope();
  const search = useAppSearch();
  const setSearch = useSetSearch();
  const window = windowOf(search.range);
  const state = useTraffic({ scope: scope.wire, window, refresh: "scraped" });
  const liveAvailable = useCapability("traffic.live") !== null;
  // Live where it was asked for, or where nothing windowed is there to read.
  const mode: Mode =
    liveAvailable &&
    (search.view === "live" ||
      (search.view !== "window" &&
        (state.says === "absent" || state.says === "noSource")))
      ? "live"
      : "window";
  const windowWords = t("traffic", WINDOW_WORD[window]);
  const toggle = (
    choices: readonly string[],
    current: string,
    pick: (each: string) => void,
    words: (each: string) => string
  ) => (
    <div className="flex items-center rounded-md border border-hair p-0.5 text-[11px]">
      {choices.map((each) => (
        <button
          key={each}
          type="button"
          aria-pressed={current === each}
          className={cn(
            "rounded-[4px] px-2 py-0.5",
            current === each ? "bg-sel text-fg" : "text-fg-mut hover:text-fg"
          )}
          onClick={() => pick(each)}
        >
          {words(each)}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex h-full flex-col gap-2">
      <SectionHeader
        title={t("traffic", "title")}
        count={
          mode === "live"
            ? t("traffic", "lastMinute")
            : state.says === "read"
              ? `${t("count", "flows", { n: state.rows.length })} · ${windowWords}`
              : windowWords
        }
        actions={
          <>
            {liveAvailable &&
              toggle(
                ["window", "live"],
                mode,
                (each) =>
                  setSearch(
                    { view: each === "live" ? "live" : "window" },
                    { replace: true }
                  ),
                (each) =>
                  t("traffic", each === "live" ? "modeLive" : "modeWindow")
              )}
            {mode === "window" &&
              toggle(
                FLOW_WINDOWS,
                window,
                (each) =>
                  setSearch(
                    { range: each === "5m" ? undefined : each },
                    { replace: true }
                  ),
                (each) => each
              )}
          </>
        }
      />
      {mode === "live" ? (
        <LiveView scope={scope.wire} scopeWords={scope.inWords} />
      ) : state.says === "read" ? (
        <WindowView
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
              [
                "needIstio",
                "needHubble",
                "needBeyla",
                "needCaretta",
                "needRelay",
              ] as const
            ).map((need) => (
              <li key={need}>{t("traffic", need)}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface Note {
  text: string;
  tone: "err" | "warn" | "mute";
}

const NOTE_TONE: Record<Note["tone"], string> = {
  err: "text-err",
  warn: "text-warn",
  mute: "text-fg-mut",
};

/** One reading, from either source, as a map over a table. */
function FlowsView({
  rows,
  scope,
  rail,
  notes,
  unread,
  quiet,
  panelWindow,
  cut,
  sharePartial,
}: {
  rows: readonly FlowRow[];
  scope: string[] | null;
  rail: ReactNode;
  notes: readonly Note[];
  unread: readonly UnreadNamespace[];
  /** What the page says where there is not a flow to draw. */
  quiet: string;
  panelWindow: string;
  cut: boolean;
  sharePartial: string | null;
}) {
  const t = useT();
  const navigate = useNavigate();
  const { open: peek } = usePeek();
  const { crdFor } = useCrdIndex();
  const search = useAppSearch();
  const canvas = useRef<GraphCanvasHandle>(null);
  const map = useTopology(scope);
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

  return (
    <>
      {notes.length > 0 && (
        <div className="flex flex-col gap-0.5 px-1 text-[11.5px]">
          {notes.map((note) => (
            <p key={note.text} className={NOTE_TONE[note.tone]}>
              {note.text}
            </p>
          ))}
        </div>
      )}
      <UnreadNamespaces unread={unread} label={t("traffic", "podsLabel")} />
      <div className="flex min-h-0 flex-1 gap-2">
        {rail}
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
            {rows.length === 0 && (
              <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-fg-mut">
                {quiet}
              </p>
            )}
            {openRow && (
              <FlowPanel
                row={openRow}
                window={panelWindow}
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
              partial={cut}
              share={{ title: t("traffic", "title"), partial: sharePartial }}
              emptyMessage={quiet}
              widthsKey="traffic-flows"
            />
          </div>
        </div>
      </div>
    </>
  );
}

/** A window of a connected Prometheus's series. */
function WindowView({
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
  const { reading, rows, sources } = state;
  const notes: Note[] = [
    ...(state.lastFailed !== null
      ? [
          {
            text: t("traffic", "lastFailed", { said: state.lastFailed }),
            tone: "err" as const,
          },
        ]
      : []),
    ...notesOf(reading, sources, t).map((text) => ({
      text,
      tone: "warn" as const,
    })),
  ];
  return (
    <FlowsView
      rows={rows}
      scope={scope}
      rail={<SourceRail sources={sources} reading={reading} />}
      notes={notes}
      unread={reading.answer.podsUnread}
      quiet={t("traffic", "nothingInWindow", {
        sources: reading.sources.map((each) => each.name).join(", "),
        scope: scopeWords,
        window: windowWords,
      })}
      panelWindow={windowWords}
      cut={reading.answer.cut > 0}
      sharePartial={partialOf(reading, sources, t)}
    />
  );
}

/** Flows as Hubble Relay sees them, over the last minute. */
function LiveView({
  scope,
  scopeWords,
}: {
  scope: string[] | null;
  scopeWords: string;
}) {
  const t = useT();
  const live = useLiveTraffic(scope, true);
  const [held] = useState(() => new LiveRows());
  const pairs = live?.pairs;
  const rows = useMemo(
    () => (pairs ? held.rows(pairs.values()) : []),
    [held, pairs]
  );
  if (!live) return null;
  const stopped = liveStopped(live, t);
  if (stopped !== null)
    return (
      <div className="flex min-h-0 flex-1 gap-2" data-testid="traffic-stopped">
        <SourceRail sources={[LIVE_SOURCE]} reading={null} />
        <p
          className={cn(
            "max-w-[72ch] px-1 py-4 text-xs",
            live.phase === "ended" ? "text-err" : "text-fg-mut"
          )}
        >
          {stopped}
        </p>
      </div>
    );
  const lastMinute = t("traffic", "lastMinute");
  const caveats: Note[] = [
    ...(live.lost > 0
      ? [
          {
            text: t("traffic", "liveLost", {
              lost: t("count", "events", { n: live.lost }),
            }),
            tone: "warn" as const,
          },
        ]
      : []),
    ...(live.untracked > 0
      ? [
          {
            text: t("traffic", "liveUntracked", {
              untracked: t("count", "events", { n: live.untracked }),
            }),
            tone: "warn" as const,
          },
        ]
      : []),
  ];
  return (
    <FlowsView
      rows={rows}
      scope={scope}
      rail={<SourceRail sources={[LIVE_SOURCE]} reading={null} />}
      notes={[
        ...(live.relay
          ? [
              {
                text: t("traffic", "liveVia", {
                  namespace: live.relay.namespace,
                  service: live.relay.service,
                  pod: live.relay.pod,
                }),
                tone: "mute" as const,
              },
            ]
          : []),
        ...caveats,
      ]}
      unread={[]}
      quiet={t("traffic", "nothingInWindow", {
        sources: LIVE_SOURCE.name,
        scope: scopeWords,
        window: lastMinute,
      })}
      panelWindow={lastMinute}
      cut={live.untracked > 0}
      sharePartial={
        caveats.length > 0 ? caveats.map((note) => note.text).join(" ") : null
      }
    />
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
