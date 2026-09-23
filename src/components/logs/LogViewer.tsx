import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { ContainerInfo, LogLevel } from "@/generated/types";
import { useToast } from "@/components/ui/use-toast";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { useCapabilityState } from "@/integrations";
import type { LogScope, UsageRange } from "@/integrations";
import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import { useDisplaySettingsStore } from "@/stores/displaySettingsStore";

import { initialFocus, type FocusReason } from "./focus";
import {
  useLogStream,
  DEFAULT_LOG_LIMIT,
  type ContainerFailure,
} from "./hooks/useLogStream";
import { useFilteredLogs } from "./hooks/useFilteredLogs";
import {
  containerEntries,
  laneColors,
  laneNameCounts,
  laneOrderWith,
  laneLabel,
  laneName,
  sourcesOf,
  type LaneLabelMode,
  type LanePod,
  type LaneRule,
} from "./lanes";
import { useLogHistory } from "./hooks/useLogHistory";
import { useIntake } from "./hooks/useIntake";
import { historyRoom, lostLines } from "./hooks/log-buffer";
import { LogHistoryBar } from "./LogHistoryBar";
import { LogToolbar } from "./LogToolbar";
import { LogLegend, type LegendEntry } from "./LogLegend";
import { LogList } from "./LogList";
import { LogDensityStrip } from "./LogDensityStrip";
import { LogStatusBar } from "./LogStatusBar";
import {
  DroppedNotice,
  FinishedNotice,
  FocusNotice,
  GroupedNotice,
  IntakeQuietNotice,
  NoEarlierRunNotice,
  StreamFailureNotice,
} from "./LogNotices";
import { LaneCoverage } from "./LaneCoverage";
import { EmptyState } from "./LogEmptyState";
import { containerColors as buildContainerColors } from "./container-colors";
import { useT } from "@/i18n/useT";
import type { Frozen } from "./hooks/log-buffer";
import {
  countCollapsed,
  expandRuns,
  groupConsecutive,
  type LogRun,
} from "./grouping";
import {
  fieldTerm,
  formatCount,
  logsToText,
  termLabel,
  type QueryTerm,
  type StreamedLogLine,
  type ViewMode,
} from "./types";

/** Before the first batch there is no index to read the legend's tally from. */
const EMPTY_COUNTS: Map<string, number> = new Map();

/**
 * Few enough rows that the pane reads as empty rather than as short, and
 * enough lines behind them that the emptiness is a lie.
 */
const COLLAPSED_ROWS = 12;
const COLLAPSED_LINES = 50;

/**
 * Digits solo by the position the legend draws, `0` shows everything.
 *
 * Bound on the window rather than on the legend because the reader's
 * focus is in the query box or nowhere at all, and a shortcut that
 * needs the legend focused first is not a shortcut. Two guards keep it
 * honest: a digit typed into the query is a digit, and a viewer parked
 * behind a hidden tab must not answer for the one on screen.
 */
function useSoloShortcuts(
  root: React.RefObject<HTMLElement | null>,
  count: number,
  onSolo: (index: number) => void,
  onShowAll: () => void
) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (!/^[0-9]$/.test(event.key)) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      const node = root.current;
      if (!node || !node.isConnected || node.closest("[hidden]")) return;

      const digit = Number(event.key);
      if (digit === 0) {
        event.preventDefault();
        onShowAll();
        return;
      }
      if (digit > count) return;
      event.preventDefault();
      onSolo(digit - 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [root, count, onSolo, onShowAll]);
}

interface LogViewerProps {
  /** The pod a single-pod pane reads. Absent on a workload pane. */
  podName?: string;
  namespace: string;
  /**
   * Every container the pod ran, init first and in run order — see
   * `podContainers`. Not just their names: a stream that ends because a
   * container died can only say why if it can reach that container's
   * `lastTerminated`, and which run to open on is decided from the same
   * field.
   */
  containers?: ContainerInfo[];
  /**
   * Every pod of a workload, one lane each. The list is live: a rollout
   * replaces it, and the pane keeps the lines of the pods that left, marks
   * their lanes gone and streams the new ones. Nothing is hidden on open.
   */
  pods?: LanePod[];
  /**
   * The pod list could not be read. An empty `pods` then means nothing was
   * looked at, not that the workload has none — the same distinction
   * `PodListCard` draws one tab away from the same query.
   */
  podsError?: unknown;
  /** What a lane stands for under this kind, said in the legend. */
  laneRule?: LaneRule;
  /**
   * A container to open alone, asked for from the Containers tab. Read
   * once, on mount, which is why the caller keys the viewer by it: a
   * request that arrives mid-session is a different reading of a
   * different log, not a filter change.
   */
  soloContainer?: string | null;
  /**
   * The controller this pane's pod belongs to, where the caller is looking at
   * one — a workload's Logs tab rather than a pod's.
   *
   * It changes one thing and nothing else: a range read from a log store is
   * asked about the *workload* instead of about the pod on screen, so it
   * spans the pods the workload has had rather than the one that happens to
   * be selected. The live half of the pane is unaffected — it is still one
   * pod's streams, because that is the only thing the API server will follow.
   */
  workload?: { owner: string; ownerKind: string } | null;
}

export function LogViewer({
  podName: podNameProp,
  namespace,
  containers: containersProp,
  pods,
  podsError,
  laneRule = "pod",
  soloContainer,
  workload,
}: LogViewerProps) {
  const t = useT();
  const { toast } = useToast();
  // Two panes in one: a pod's containers, or a workload's pods. `lanes`
  // is the switch, and every "which lane is this line in" question below
  // asks it once through `laneOf`.
  const lanes = pods !== undefined;
  const podName = podNameProp ?? "";
  const containerInfos = useMemo<ContainerInfo[]>(() => {
    if (!lanes) return containersProp ?? [];
    const seen = new Map<string, ContainerInfo>();
    for (const pod of pods) {
      for (const container of pod.containers) {
        if (!seen.has(container.name)) seen.set(container.name, container);
      }
    }
    return [...seen.values()];
  }, [lanes, containersProp, pods]);
  const containers = useMemo(
    () => containerInfos.map((container) => container.name),
    [containerInfos]
  );
  const sources = useMemo(
    () => (lanes ? sourcesOf(pods) : undefined),
    [lanes, pods]
  );
  const pane = lanes
    ? `${workload?.ownerKind ?? "pods"}:${workload?.owner ?? ""}`
    : podName;
  const laneOf = useCallback(
    (log: StreamedLogLine) => (lanes ? log.pod : log.container),
    [lanes]
  );
  const [labelMode, setLabelMode] = useState<LaneLabelMode>("colour");
  const copyToClipboard = useCopyToClipboard();
  // Every container streams, always. Hiding one is a view filter and
  // nothing more: stopping its stream would make its line count a lie the
  // moment it came back, and a sidecar bug is invisible one container at a
  // time. Nothing is hidden on open either — a filter the reader did not
  // set is a lie about how much log there is.
  //
  // Except when the pod is held in init. Then "show everything" shows
  // nothing — the app container has never started — and the one log that
  // answers the question is the failing init container's previous run.
  // Decided once, on mount, and announced above the output.
  const [focus] = useState(() =>
    lanes
      ? { hidden: new Set<string>(), previous: false, reason: null }
      : initialFocus(containerInfos, soloContainer)
  );
  const [hidden, setHidden] = useState<ReadonlySet<string>>(focus.hidden);
  const [previousRun, setPreviousRun] = useState(focus.previous);
  /** Retired the moment the reader touches the legend: it describes an
   *  opening state, and a stale explanation is worse than none. */
  const [focusReason, setFocusReason] = useState<FocusReason | null>(
    focus.reason
  );
  const [terms, setTerms] = useState<QueryTerm[]>([]);
  /**
   * Which terms are also kept at the source, by label.
   *
   * A mode per term rather than one intake control for the toolbar: the
   * reader mixes them — `component=ingest` worth restarting the stream for,
   * `level≥warn` worth flipping off a moment later — and a single
   * toolbar-wide intake cannot express that.
   *
   * Kept beside the terms rather than inside them because `QueryTerm` is
   * generated from Rust and is the shape the backend is handed; the mode
   * is the viewer's business alone.
   */
  const [intakeLabels, setIntakeLabels] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [draft, setDraft] = useState("");
  const [limit, setLimit] = useState(DEFAULT_LOG_LIMIT);
  const [frozen, setFrozen] = useState<Frozen | null>(null);
  const [collapseRepeats, setCollapseRepeats] = useState(true);
  const [expandedRuns, setExpandedRuns] = useState<ReadonlySet<number>>(
    () => new Set()
  );
  const [expandedLines, setExpandedLines] = useState<ReadonlySet<number>>(
    () => new Set()
  );
  const [viewMode, setViewMode] = useState<ViewMode>("compact");
  const [autoScroll, setAutoScroll] = useState(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  // Where the reader is, in wall clock, so the strip can mark it. Two
  // numbers rather than an object: React bails out of the re-render when
  // neither has moved, and this is reported on every scroll and batch.
  const [viewportFrom, setViewportFrom] = useState(0);
  const [viewportTo, setViewportTo] = useState(0);
  const [scrollTarget, setScrollTarget] = useState<{ index: number } | null>(
    null
  );

  // Remembered like the table density and shared with the peek: whether a
  // chart belongs over a log is a fact about the reader, not about the pane
  // they happen to be reading in.
  const stripMode = useDisplaySettingsStore((state) => state.densityStrip);
  const setStripMode = useDisplaySettingsStore(
    (state) => state.setDensityStrip
  );

  // Every chip filters the view; the ones flipped to intake also filter
  // the stream, so the toggle changes what is kept and never what is
  // shown. `useIntake` holds the set still for a moment so a run of
  // flips is one restart.
  const intakeTerms = useMemo(
    () => terms.filter((term) => intakeLabels.has(termLabel(term))),
    [terms, intakeLabels]
  );
  const intake = useIntake(intakeTerms);

  const {
    logs: live,
    fields,
    dropped,
    frozenLines,
    isStreaming,
    isConnecting,
    isPaused,
    failures,
    lastBatchAt,
    intakeFrom,
    unfilteredFrom,
    clearLogs,
    togglePause,
    retry,
    retrySource,
  } = useLogStream({
    podName: lanes ? undefined : podName,
    namespace,
    containers: lanes ? undefined : containers,
    sources,
    paneKey: lanes ? pane : undefined,
    limit,
    previous: previousRun,
    intake,
    frozen,
    // The lines an interval was holding are gone with the buffer, so the
    // freeze goes with them rather than sitting in the toolbar offering to
    // thaw a window that can never refill.
    onWiped: useCallback(() => setFrozen(null), []),
  });

  // Not `dropped > 0`: with an interval frozen, eviction steps over it and
  // takes what is around it, so the missing lines are a hole beside the
  // kept block and not a head the log starts after.
  const lost = lostLines(dropped, frozen);

  /**
   * Every lane the pane has seen: the pods on the list, and the pods no
   * longer on it whose lines the buffer still holds. Read off the buffer
   * rather than remembered, so a lane exists exactly as long as a line of
   * it does.
   */
  const historyCapability = useCapabilityState("logs.history");
  const history = useLogHistory(
    historyCapability.state === "ready" ? historyCapability.use : null
  );

  const laneKeys = useMemo(() => {
    if (!lanes) return containers;
    const keys = pods.map((pod) => pod.name);
    for (const key of fields.values.get("pod")?.keys() ?? []) {
      if (!keys.includes(key)) keys.push(key);
    }
    // A history read is the reason a workload scope exists: its pods from
    // an hour ago are gone from every list the API server will answer.
    // They are not in the live buffer's index either — those lines are
    // merged in beside it — so without this they arrive with no chip, no
    // colour and no way to hide them.
    for (const line of history.lines) {
      if (!keys.includes(line.pod)) keys.push(line.pod);
    }
    return keys;
  }, [lanes, containers, pods, fields, history.lines]);
  const gone = useMemo(() => {
    if (!lanes) return new Set<string>();
    const present = new Set(pods.map((pod) => pod.name));
    return new Set(laneKeys.filter((key) => !present.has(key)));
  }, [lanes, pods, laneKeys]);
  // The order lanes were first seen in, appended to and never reordered.
  // A hue taken from the position in the *live* list moved every lane after
  // a pod that dropped out of it, so the lines already in the buffer
  // repainted themselves mid-rollout and the replacement inherited the
  // colour the reader was following.
  const [laneOrder, setLaneOrder] = useState<string[]>([]);
  const [orderedFrom, setOrderedFrom] = useState(laneKeys);
  if (laneKeys !== orderedFrom) {
    // React's own "adjust state when a prop changes": the order has to be
    // right in this render, not one render later, or a new lane flashes in
    // the colour of the lane it is about to sit beside.
    setOrderedFrom(laneKeys);
    setLaneOrder((prev) => laneOrderWith(prev, laneKeys));
  }
  const colors = useMemo(
    () =>
      lanes
        ? laneColors(laneKeys, gone, laneOrder)
        : buildContainerColors(containers),
    [lanes, laneKeys, gone, laneOrder, containers]
  );
  const laneNames = useMemo(
    () => laneNameCounts(pods ?? [], laneRule),
    [pods, laneRule]
  );
  const podByName = useMemo(
    () => new Map((pods ?? []).map((pod) => [pod.name, pod])),
    [pods]
  );
  const laneLabelOf = useCallback(
    (log: StreamedLogLine) =>
      lanes
        ? laneLabel(
            podByName.get(log.pod) ?? null,
            log.pod,
            laneRule,
            labelMode,
            laneNames
          )
        : null,
    [lanes, podByName, laneRule, labelMode, laneNames]
  );

  // A pod's own lines outlive the pod only if somebody shipped them
  // somewhere. Asked for by facet, so this pane never learns which store
  // answered — it prints the name it is handed and branches on nothing.
  const [historyRange, setHistoryRange] = useState<UsageRange | null>(null);

  /**
   * What a range is asked about: the workload where there is one, the pod
   * otherwise.
   *
   * The workload scope is the reason this is worth having on a Logs tab at
   * all — its pods from an hour ago are gone from every list the API server
   * will answer, and they are exactly the ones somebody debugging a rollout
   * came to read.
   */
  const historyScope = useMemo<LogScope>(
    () =>
      workload
        ? {
            kind: "workload",
            namespace,
            owner: workload.owner,
            ownerKind: workload.ownerKind,
          }
        : { kind: "pod", namespace, pod: podName },
    [workload, namespace, podName]
  );

  const handleReadHistory = useCallback(
    (range: UsageRange) => {
      setHistoryRange(range);
      history.read(historyScope, range);
    },
    [history, historyScope]
  );

  const handleClearHistory = useCallback(() => {
    setHistoryRange(null);
    history.clear();
  }, [history]);

  /**
   * History in front of the live buffer, and **the first thing to go when
   * the buffer is full**.
   *
   * That order is the contract, not an implementation detail: the live
   * stream is the answer this pane owed before any integration existed, and
   * a range that pushed live lines out of a `Keep 5 000` buffer would have
   * made the viewer worse for having a Loki.
   */
  const { logs, historyHeld } = useMemo(() => {
    if (history.lines.length === 0) return { logs: live, historyHeld: 0 };
    const room = historyRoom(limit, live.length, frozenLines);
    const kept =
      room >= history.lines.length
        ? history.lines
        : history.lines.slice(history.lines.length - room);
    return { logs: [...kept, ...live], historyHeld: kept.length };
  }, [history.lines, live, limit, frozenLines]);

  // Everything the pane is holding, history included — the status bar's fill
  // and the "N lines received" sentences are about the buffer on screen and
  // not about which half of it arrived over a socket.
  const retained = logs.length;

  // Counted over the whole buffer rather than the view, so hiding a
  // container does not zero the number that says how loud it is. The
  // field index already keeps exactly this tally, incrementally, so the
  // legend no longer costs a pass over the buffer per batch.
  const counts = fields.values.get(lanes ? "pod" : "container") ?? EMPTY_COUNTS;

  // What is being typed filters live and becomes a chip on Enter, so the
  // box answers immediately and the answer survives being typed past.
  const effectiveTerms = useMemo<QueryTerm[]>(() => {
    const typed = draft.trim();
    return typed === "" ? terms : [...terms, { kind: "text", value: typed }];
  }, [terms, draft]);

  const highlight = useMemo(() => {
    const typed = draft.trim();
    if (typed !== "") return typed;
    const text = terms.filter((term) => term.kind === "text");
    return text.length > 0 ? text[text.length - 1].value : "";
  }, [terms, draft]);

  /**
   * Two filtered views, because the strip and the list are not asking the
   * same question.
   *
   * `scoped` is everything the query allows except the time range;
   * `visibleLogs` is that narrowed to the range. The strip draws `scoped`
   * so the map keeps its full extent while a range is selected — filter
   * the strip by its own selection and dragging out four minutes leaves a
   * strip of four minutes, with nowhere left to drag back to.
   */
  const { time, rest } = useMemo(() => {
    const time = effectiveTerms.find((term) => term.kind === "time");
    return {
      time,
      rest: time
        ? effectiveTerms.filter((term) => term.kind !== "time")
        : effectiveTerms,
    };
  }, [effectiveTerms]);
  const { scoped, settling } = useFilteredLogs(logs, hidden, rest, laneOf);
  const visibleLogs = useMemo(
    () =>
      time
        ? scoped.filter((log) => log.epoch >= time.from && log.epoch <= time.to)
        : scoped,
    [scoped, time]
  );

  const timeRange = useMemo(() => {
    const term = terms.find((entry) => entry.kind === "time");
    return term ? { from: term.from, to: term.to } : null;
  }, [terms]);

  // What the strip's accumulator treats as "the same set, extended".
  // Anything that reshuffles the filtered array has to appear here or the
  // histogram would go on adding to slices built from a different query.
  const scopeKey = useMemo(
    () =>
      `${namespace}/${pane}|${[...hidden].sort().join(",")}|${effectiveTerms
        .filter((term) => term.kind !== "time")
        .map(termLabel)
        .join(",")}`,
    [namespace, pane, hidden, effectiveTerms]
  );

  // Grouping runs after filtering, so a filter that leaves two repeats
  // adjacent collapses them — the reader asked to see only these.
  const runs = useMemo(
    () => groupConsecutive(visibleLogs, collapseRepeats),
    [visibleLogs, collapseRepeats]
  );
  const rows = useMemo(
    () => expandRuns(visibleLogs, runs, expandedRuns),
    [visibleLogs, runs, expandedRuns]
  );
  const collapsedCount = useMemo(() => countCollapsed(runs), [runs]);

  const handleViewportRange = useCallback((from: number, to: number) => {
    setViewportFrom(from);
    setViewportTo(to);
  }, []);

  /**
   * A slice, clicked. The follow has to come off in the same update — a
   * list still pinned to the tail would scroll back within the quarter
   * second, and the click would read as broken rather than as ignored.
   */
  const handleJumpToTime = useCallback(
    (epoch: number) => {
      if (rows.length === 0) return;
      setAutoScroll(false);
      setIsAtBottom(false);
      setScrollTarget({ index: firstRowAtOrAfter(rows, epoch) });
    },
    [rows]
  );

  // At most one time range at a time, so a second drag replaces the first
  // rather than intersecting with it — two ranges anded together is a
  // question nobody asked by dragging.
  const handleSelectRange = useCallback((from: number, to: number) => {
    setAutoScroll(false);
    setTerms((prev) => [
      ...prev.filter((term) => term.kind !== "time"),
      { kind: "time", from, to },
    ]);
  }, []);

  const handleClearRange = useCallback(() => {
    setTerms((prev) => prev.filter((term) => term.kind !== "time"));
  }, []);

  const handleToggleRun = useCallback((id: number) => {
    setExpandedRuns((prev) => toggled(prev, id));
  }, []);

  const handleToggleLine = useCallback((id: number) => {
    setExpandedLines((prev) => toggled(prev, id));
  }, []);

  const handleToggleContainer = useCallback((name: string) => {
    setFocusReason(null);
    setHidden((prev) => toggled(prev, name));
  }, []);

  const handleShowAllContainers = useCallback(() => {
    setFocusReason(null);
    setHidden(new Set());
  }, []);

  /**
   * Everything else off — or, on the container that is already alone,
   * everything back on. One gesture in both directions, which is what
   * makes it safe to reach for on a five-container pod.
   */
  const handleSoloContainer = useCallback(
    (name: string) => {
      setFocusReason(null);
      setHidden((prev) => {
        const alone = !prev.has(name) && laneKeys.length - prev.size === 1;
        return alone
          ? new Set()
          : new Set(laneKeys.filter((other) => other !== name));
      });
    },
    [laneKeys]
  );

  const handleSoloByIndex = useCallback(
    (index: number) => {
      const name = laneKeys[index];
      if (name !== undefined) handleSoloContainer(name);
    },
    [laneKeys, handleSoloContainer]
  );

  const rootRef = useRef<HTMLDivElement>(null);
  useSoloShortcuts(
    rootRef,
    laneKeys.length,
    handleSoloByIndex,
    handleShowAllContainers
  );

  const handlePreviousRunToggle = useCallback(() => {
    setFocusReason(null);
    setPreviousRun((on) => !on);
  }, []);

  const handleShowCurrentRun = useCallback(() => {
    setFocusReason(null);
    setPreviousRun(false);
  }, []);

  const handleAddTerm = useCallback((term: QueryTerm) => {
    setTerms((prev) =>
      prev.some((existing) => termLabel(existing) === termLabel(term))
        ? prev
        : [...prev, term]
    );
  }, []);

  const handleRemoveTerm = useCallback((term: QueryTerm) => {
    const label = termLabel(term);
    setTerms((prev) =>
      prev.filter((existing) => termLabel(existing) !== label)
    );
    // Taking the chip away takes its intake with it — which restarts the
    // stream, and the same sentence gets said about the gap.
    setIntakeLabels((prev) => (prev.has(label) ? without(prev, label) : prev));
  }, []);

  const handleToggleIntake = useCallback((term: QueryTerm) => {
    setIntakeLabels((prev) => toggled(prev, termLabel(term)));
  }, []);

  // The freeze outlives the chip on purpose: the chip is a question about
  // what to show, the freeze is about what to keep, and taking the filter
  // off to watch the tail must not throw the held lines away. The status
  // bar keeps the handle that thaws it.
  const handleToggleFreeze = useCallback((term: QueryTerm) => {
    if (term.kind !== "time") return;
    setFrozen((prev) =>
      prev !== null && prev.from === term.from && prev.to === term.to
        ? null
        : { from: term.from, to: term.to }
    );
  }, []);

  const handleThaw = useCallback(() => setFrozen(null), []);

  const handleClearQuery = useCallback(() => {
    setTerms([]);
    setIntakeLabels(new Set());
    setDraft("");
  }, []);

  // One builder for every pair anyone clicks — a row's field key, the
  // container in its detail, the level in the Table view, a suggestion in
  // the query popover. Two of them producing terms that only looked alike
  // would defeat the label-based dedupe and stack two chips saying the
  // same thing.
  const handleFieldClick = useCallback(
    (key: string, value: string) => {
      handleAddTerm(fieldTerm(key, value));
    },
    [handleAddTerm]
  );

  const handleLevelClick = useCallback(
    (level: LogLevel) => {
      handleAddTerm(fieldTerm("level", level));
    },
    [handleAddTerm]
  );

  const handleAutoScrollToggle = useCallback(() => {
    // Turning it back on is the same act as jumping to the foot: the list
    // pins itself the moment `follow` flips true.
    setAutoScroll((previous) => !previous);
  }, []);

  const handleCopyLogs = useCallback(() => {
    if (visibleLogs.length === 0) return;
    // Not while the filter is still walking: what is here is how far it got,
    // and copying it would hand over a subset with a count stated as fact.
    if (settling) return;
    copyToClipboard(
      logsToText(visibleLogs),
      t("count", "linesCopied", {
        n: visibleLogs.length,
        count: formatCount(visibleLogs.length),
      })
    );
  }, [copyToClipboard, visibleLogs, settling, t]);

  const shownContainers = useMemo(
    () => (lanes ? containers : containers.filter((name) => !hidden.has(name))),
    [lanes, containers, hidden]
  );
  /** The lanes in view: pods on a workload pane, containers otherwise. */
  const shownLanes = useMemo(
    () => laneKeys.filter((key) => !hidden.has(key)),
    [laneKeys, hidden]
  );

  const handleDownloadLogs = useCallback(async () => {
    // Straight from the API, not from the buffer: this is the answer to
    // "the head has been dropped", and reading the same truncated array
    // back out would be no answer at all. One file per container, because
    // `get_pod_logs` reads one container and interleaving several
    // one-shot reads would invent an ordering the API never gave.
    // A workload pane downloads every pod still there, the last ten
    // thousand lines of each stream; a pod that is gone has no log left
    // to ask for.
    const targets = lanes
      ? (sources ?? []).filter(
          (source) => shownLanes.length === 0 || shownLanes.includes(source.pod)
        )
      : (shownContainers.length > 0 ? shownContainers : containers).map(
          (container) => ({ pod: podName, namespace, container })
        );
    // Per target, not around the loop: one pod whose log the node dropped
    // used to take every pod after it down with it, and the reader was told
    // the API could not be read — over a fact the backend had just named.
    const refused: string[] = [];
    const saved: string[] = [];
    for (const target of targets) {
      try {
        // Written by the backend straight into Downloads: the log never
        // crosses IPC as ten thousand parsed lines just to become a file.
        saved.push(
          await commands.savePodLog(
            target.pod,
            target.namespace,
            target.container,
            10000,
            // The file has to be the log on screen. Downloading the current
            // run while the pane reads the previous one hands the reader a
            // different log under the same name.
            previousRun
          )
        );
      } catch (err) {
        console.error("Failed to download logs:", err);
        refused.push(`${target.pod}/${target.container}: ${errorToShow(err)}`);
      }
    }
    if (saved.length > 0) {
      toast({
        title: t("action", "logSaved", { n: saved.length }),
        description: saved.join("\n"),
      });
    }
    if (refused.length > 0) {
      toast({
        title: t("action", "downloadFailed"),
        description: refused.join("\n"),
        variant: "destructive",
      });
    }
  }, [
    containers,
    lanes,
    namespace,
    podName,
    previousRun,
    shownContainers,
    shownLanes,
    sources,
    t,
    toast,
  ]);

  // What the reader is not being shown: dropped by the query or by the
  // legend, plus the lines standing behind a collapsed run. Nothing while
  // the walk is on — every line it has not reached yet would be counted as
  // one the filter rejected, which is a number about work not yet done.
  const hiddenByView = settling
    ? 0
    : retained - visibleLogs.length + collapsedCount;

  // Offered where it can answer. The kubelet sets `lastTerminated` for
  // exactly the container instances whose logs `--previous` still
  // fetches, so this is knowable before asking rather than from an error.
  const offerPreviousRun = containerInfos.some(
    (info) => info.lastTerminated !== null
  );

  // A container reading alone, finished, from a phase of the pod's life
  // that is over. Derived from the current view rather than from the
  // opening one: it is as true after a solo as it was on mount.
  const finished = useMemo(() => {
    if (lanes || shownContainers.length !== 1) return null;
    const info = containerInfos.find(
      (entry) => entry.name === shownContainers[0]
    );
    if (!info || info.phase === "app" || info.state.type !== "terminated") {
      return null;
    }
    return info;
  }, [lanes, containerInfos, shownContainers]);

  const laneOfFailure = (failure: ContainerFailure) =>
    lanes ? failure.pod : failure.container;
  const streamsInView = lanes
    ? (sources ?? []).filter((source) => !hidden.has(source.pod)).length
    : shownContainers.length;

  // "There is no earlier run of this one" is a fact about a container, not
  // about the pane, and the legend chip already carries it beside the name.
  // It is only worth a banner when it is the whole answer — every container
  // in view saying it, so the pane is empty because of it. Otherwise a
  // three-container pod stacks three warnings over a log that reads fine.
  const absentInView = failures.filter(
    (failure) =>
      failure.kind === "no-previous-run" && !hidden.has(laneOfFailure(failure))
  );
  const nothingEarlier =
    streamsInView > 0 && absentInView.length === streamsInView;
  const bannered = failures.filter((failure) => {
    // Hiding a container hides everything about it, its trouble
    // included. A soloed pane that stacks three banners about
    // containers the reader took out of view is arguing with the
    // filter it was just given — the legend marks them, and unhiding
    // one brings its sentence back with it.
    if (hidden.has(laneOfFailure(failure))) return false;
    if (failure.kind === "no-previous-run") {
      return nothingEarlier && absentInView.length === 1;
    }
    // On a workload pane a pod that ended is a grey lane, not a banner:
    // rollouts end pods all the time and the legend already says so.
    if (lanes && failure.kind === "gone") return false;
    // An init container that finished ends its stream on the way out.
    // That is the read completing, not the container disappearing —
    // the legend says "ended" and the notice above says the log is
    // whole, and "is gone" over a successful step is alarm for nothing.
    const info = containerInfos.find(
      (entry) => entry.name === failure.container
    );
    return !(failure.kind === "gone" && info?.state.type === "terminated");
  });

  /**
   * What the API server has run out of answers for, named.
   *
   * Exactly the two dead ends the pane already states above the output — a
   * stream that ended because the container is gone, and a container that
   * has never started — reused rather than re-derived, so the offer cannot
   * appear beside a notice that is not there or go missing beside one that
   * is. Everywhere else this is `null` and no offer is drawn.
   */
  const stranded = useMemo(() => {
    if (lanes) return null;
    // A log the node dropped is the strongest case of all: it is not on the
    // apiserver at any address, and a history vendor is the only thing left
    // that can still produce it.
    const gone = bannered
      .filter(
        (failure) => failure.kind === "gone" || failure.kind === "log-not-kept"
      )
      .map((failure) => failure.container);
    if (gone.length > 0) return `${podName}/${gone.join(", ")}`;
    const unstarted = containerInfos.filter(
      (info) =>
        !hidden.has(info.name) &&
        info.state.type === "waiting" &&
        info.lastTerminated === null &&
        info.restartCount === 0
    );
    if (unstarted.length > 0) {
      return `${podName}/${unstarted.map((info) => info.name).join(", ")}`;
    }
    return null;
  }, [lanes, bannered, containerInfos, hidden, podName]);

  const legendEntries = useMemo<LegendEntry[]>(
    () =>
      lanes
        ? laneKeys.map((key) => ({
            key,
            label:
              labelMode === "short"
                ? (laneLabel(
                    podByName.get(key) ?? null,
                    key,
                    laneRule,
                    "short",
                    laneNames
                  ) ?? key)
                : laneName(
                    podByName.get(key) ?? null,
                    key,
                    laneRule,
                    laneNames
                  ),
            gone: gone.has(key),
          }))
        : containerEntries(containerInfos),
    [
      lanes,
      laneKeys,
      labelMode,
      podByName,
      laneRule,
      laneNames,
      gone,
      containerInfos,
    ]
  );
  /**
   * What is actually attached, counted over pods.
   *
   * `gone` is not a refusal. The streamer emits it whenever a followed
   * stream reaches EOF, which is the ordinary end of every init container
   * and of every pod of a finished Job — so counting any failure as
   * not-streaming made a Deployment with one migration init container read
   * "0 of 3 pods streaming" while all three were writing into the pane.
   *
   * `refused` counts pods, not streams, because the sentence beside it
   * counts pods; and a paused pane is not an unread one, so the whole
   * sentence steps aside while the reader has stopped it.
   */
  const coverage = useMemo(() => {
    if (!lanes) return null;
    const terminated = new Set(
      pods.flatMap((pod) =>
        pod.containers
          .filter((container) => container.state.type === "terminated")
          .map((container) => `${pod.name}/${container.name}`)
      )
    );
    const unread = (failure: ContainerFailure) => {
      if (failure.kind === "no-previous-run") return false;
      // Read to the end, not refused: the container finished.
      if (
        failure.kind === "gone" &&
        terminated.has(`${failure.pod}/${failure.container}`)
      ) {
        return false;
      }
      return true;
    };
    const unreadable = failures.filter(unread);
    // Counted over pods, because the clause beside it counts pods and the
    // noun is elided. `broken` is the could-not-look state, so the
    // sentence says that rather than claiming a refusal.
    const refused = new Set(
      unreadable
        .filter((failure) => !gone.has(failure.pod))
        .map((failure) => failure.pod)
    ).size;
    const streaming = pods.filter(
      (pod) => !unreadable.some((failure) => failure.pod === pod.name)
    ).length;
    return { total: pods.length, streaming, refused, gone: gone.size };
  }, [lanes, pods, failures, gone]);

  return (
    <div ref={rootRef} className="flex h-full flex-col">
      {/* Above the toolbar because it is the first question, not the
          fourth: the shape of the buffer is what tells the reader where
          to point the query. Hidden outright, it leaves nothing behind —
          the ⋯ menu is where it went and where it comes back from. */}
      {stripMode !== "off" && (
        <LogDensityStrip
          logs={scoped}
          scope={scopeKey}
          retained={retained}
          settling={settling}
          lost={lost}
          intake={intake.length > 0}
          selection={timeRange}
          frozen={frozen}
          viewportFrom={viewportFrom}
          viewportTo={viewportTo}
          onJump={handleJumpToTime}
          onSelect={handleSelectRange}
          onClearSelection={handleClearRange}
          mode={stripMode}
          onModeChange={setStripMode}
        />
      )}

      <LogToolbar
        terms={terms}
        draft={draft}
        onDraftChange={setDraft}
        onAddTerm={handleAddTerm}
        onRemoveTerm={handleRemoveTerm}
        intake={intakeLabels}
        onToggleIntake={handleToggleIntake}
        frozen={frozen}
        onToggleFreeze={handleToggleFreeze}
        fields={fields}
        limit={limit}
        onLimitChange={setLimit}
        collapseRepeats={collapseRepeats}
        onCollapseRepeatsChange={setCollapseRepeats}
        previousRun={previousRun}
        offerPreviousRun={offerPreviousRun}
        onPreviousRunToggle={handlePreviousRunToggle}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        isStreaming={isStreaming}
        isConnecting={isConnecting}
        isPaused={isPaused}
        autoScroll={autoScroll}
        isAtBottom={isAtBottom}
        onAutoScrollToggle={handleAutoScrollToggle}
        onClearLogs={clearLogs}
        onCopyLogs={handleCopyLogs}
        onDownloadLogs={handleDownloadLogs}
        onToggleStreaming={togglePause}
        stripMode={stripMode}
        onStripModeChange={setStripMode}
      />

      <LogLegend
        entries={legendEntries}
        colors={colors}
        counts={counts}
        hidden={hidden}
        failures={failures}
        failureKey={laneOfFailure}
        onToggle={handleToggleContainer}
        onSolo={handleSoloContainer}
        onShowAll={handleShowAllContainers}
        trailing={
          coverage ? (
            <LaneCoverage
              paused={isPaused}
              coverage={coverage}
              rule={laneRule}
              mode={labelMode}
              onModeChange={setLabelMode}
            />
          ) : undefined
        }
      />

      {/* Directly under the legend it narrowed, and above everything that
          explains the output — the reader has to know which containers
          and which run these lines are before reading a line of them. */}
      {focusReason && (
        <FocusNotice
          reason={focusReason}
          onShowAll={handleShowAllContainers}
          onShowCurrentRun={handleShowCurrentRun}
        />
      )}

      {/* Not while a failure above is already accounting for the pane: a
          finished container whose earlier run does not exist would
          otherwise be told its complete log is on screen when nothing
          is. */}
      {!focusReason &&
        finished &&
        !bannered.some((failure) => failure.container === finished.name) && (
          <FinishedNotice container={finished} />
        )}

      {nothingEarlier && absentInView.length > 1 && (
        <NoEarlierRunNotice
          containers={absentInView.map((failure) => failure.container)}
          onShowCurrentRun={handleShowCurrentRun}
        />
      )}

      {lost !== "none" && (
        <DroppedNotice
          dropped={dropped}
          limit={limit}
          lost={lost}
          onDownload={handleDownloadLogs}
        />
      )}

      {/* One notice per container whose stream died. Four containers can
          still be streaming while the fifth is gone, and a single verdict
          could not say which. */}
      {bannered.map((failure) => (
        <StreamFailureNotice
          key={`${failure.pod}/${failure.container}`}
          failure={failure}
          podName={lanes ? failure.pod : podName}
          container={
            // The first container of that name across every pod is another
            // pod's status: its exit code, its restart count, its reason.
            // On a workload pane the failure names which pod it is about.
            lanes
              ? podByName
                  .get(failure.pod)
                  ?.containers.find((info) => info.name === failure.container)
              : containerInfos.find((info) => info.name === failure.container)
          }
          intake={intake.length > 0}
          previousRun={previousRun}
          onRetry={
            // One lane at a time where there are lanes: the session-wide
            // retry clears the buffer, which on a workload pane is every
            // other pod's lines — including the pods that have left, whose
            // streams are gone and cannot be read back.
            lanes ? () => retrySource(failure.pod, failure.container) : retry
          }
          onShowCurrentRun={handleShowCurrentRun}
        />
      ))}

      {/* Under the sentence that said there is nothing left to read, which
          is the only place an offer to read it elsewhere makes sense. */}
      <LogHistoryBar
        capability={historyCapability}
        history={history.state}
        stranded={stranded}
        ranged={workload !== undefined && workload !== null}
        held={historyHeld}
        keep={limit}
        selected={historyRange}
        isPaging={history.isPaging}
        onRead={handleReadHistory}
        onReadOlder={history.readOlder}
        onClear={handleClearHistory}
      />

      {/* Only while the stream is up and nothing else is explaining the
          silence: a failed stream has its own notice above, and two
          verdicts about the same quiet would compete. */}
      {intake.length > 0 && isStreaming && failures.length === 0 && (
        <IntakeQuietNotice since={lastBatchAt} terms={intake} />
      )}

      {rows.length > 0 &&
        rows.length <= COLLAPSED_ROWS &&
        collapsedCount >= COLLAPSED_LINES && (
          <GroupedNotice
            rows={rows.length}
            collapsed={collapsedCount}
            onShowEveryLine={() => setCollapseRepeats(false)}
          />
        )}

      <LogList
        logs={visibleLogs}
        rows={rows}
        expandedRuns={expandedRuns}
        onToggleRun={handleToggleRun}
        expandedLines={expandedLines}
        onToggleLine={handleToggleLine}
        containerColors={colors}
        laneOf={laneOf}
        laneLabelOf={laneLabelOf}
        viewMode={viewMode}
        searchQuery={highlight}
        follow={autoScroll}
        atBottom={isAtBottom}
        onFollowChange={setAutoScroll}
        onAtBottomChange={setIsAtBottom}
        resetKey={`${namespace}/${pane}`}
        oldestRetainedId={logs[0]?.id}
        onViewportRangeChange={handleViewportRange}
        scrollTarget={scrollTarget}
        onFieldClick={handleFieldClick}
        onLevelClick={handleLevelClick}
      >
        <EmptyState
          failed={bannered.length > 0}
          connecting={isConnecting}
          streaming={isStreaming}
          retained={retained}
          filtered={effectiveTerms.length > 0}
          settling={settling}
          intake={intake.length > 0}
          allHidden={shownLanes.length === 0 && laneKeys.length > 0}
          noPods={lanes && pods.length === 0 && laneKeys.length === 0}
          podsUnread={podsError}
          lanes={lanes}
          onClearQuery={handleClearQuery}
          onShowAll={handleShowAllContainers}
        />
      </LogList>

      {/* The status bar carries the live indicator: a pulsing dot beside the
          word "Streaming", which is the only thing that separates an attached
          stream from a dead pane. */}
      <LogStatusBar
        logs={logs}
        retained={retained}
        frozen={frozen}
        frozenLines={frozenLines}
        onThaw={handleThaw}
        limit={limit}
        shownCount={rows.length}
        settling={settling}
        hiddenCount={hiddenByView}
        intake={intake}
        intakeFrom={intakeFrom}
        unfilteredFrom={unfilteredFrom}
        isStreaming={isStreaming}
      />
    </div>
  );
}

/**
 * The first row at or after an instant.
 *
 * Binary search over the rows the list is actually drawing, not over the
 * buffer: a run of two thousand collapsed repeats is one row, and landing
 * on the line's index would put the reader thousands of rows past where
 * they pointed. Rows are ordered by time to within one reorder window,
 * which is finer than any slice the strip can draw.
 */
function firstRowAtOrAfter(rows: LogRun[], epoch: number): number {
  let low = 0;
  let high = rows.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (rows[mid].tail.epoch < epoch) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Add or drop one member, without mutating the set the render read. */
function toggled<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

function without<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set);
  next.delete(value);
  return next;
}
