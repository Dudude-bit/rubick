import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands } from "@/lib/commands";
import type { LogFormat, LogLevel, StreamLogConfig } from "@/generated/types";
import { normalizeTauriError } from "@/lib/error-utils";
import {
  listenForStreamFailures,
  type StreamFailure,
} from "@/lib/stream-failure";

import { groupKeyFor } from "../normalize";
import type { QueryTerm, StreamedLogLine } from "../types";
import {
  appendCapped,
  backfillPerContainer,
  emptyBuffer,
  MAX_PENDING_LINES,
  orderByTimestamp,
  REORDER_WINDOW_MS,
  type FieldIndex,
  type LogBuffer,
} from "./log-buffer";

/**
 * The one number. It bounds the backfill the stream opens with *and*
 * the lines the viewer keeps, because they were two numbers saying
 * different things: a selector reading "100 lines" sat above a viewer
 * holding forty thousand, and neither number described what was on
 * screen.
 *
 * 5 000 is the default rather than the ceiling. A retained line costs
 * about 1.1 KB now the list is virtualised, so the top option is still
 * 40 000 for anyone who wants three minutes of a chatty pod instead of
 * twenty seconds.
 */
export const DEFAULT_LOG_LIMIT = 5000;

/** What the "keep" control offers. Ascending; the first is the default. */
export const LOG_LIMITS = [1000, 5000, 20000, 40000] as const;

/** A stream that stopped on its own, and the container it belonged to. */
export interface ContainerFailure extends StreamFailure {
  container: string;
}

interface LogBatchPayload {
  stream_id: string;
  lines: Array<{
    message: string;
    timestamp: string | null;
    level: LogLevel | null;
    format: LogFormat | null;
    fields: Record<string, string> | null;
    raw: string;
  }>;
}

interface UseLogStreamOptions {
  podName: string;
  namespace: string;
  /**
   * One stream is opened per entry. A multi-container pod raises exactly
   * one question — what was the sidecar doing when the app failed — and
   * a viewer that shows one container at a time cannot be asked it.
   */
  containers: string[];
  /** Backfill and retention, together. See `DEFAULT_LOG_LIMIT`. */
  limit: number;
  /**
   * Terms every arriving line must satisfy to be kept at all, evaluated
   * in Rust before the line costs an event, an IPC hop or a slot. Empty
   * is the default and keeps everything.
   *
   * Changing this restarts the streams and nothing else: the buffer goes
   * on holding every line it already has, which is why promoting a chip
   * is not a destructive act and has nothing to confirm.
   */
  intake?: QueryTerm[];
}

interface UseLogStreamResult {
  logs: StreamedLogLine[];
  /** `logs.length`, named so a status bar does not have to explain itself. */
  retained: number;
  limit: number;
  /**
   * What the retained lines can be filtered by, counted as they arrived.
   * Counting it here rather than in a memo over `logs` is the difference
   * between an O(1) append and a 40 000-line scan four times a second.
   */
  fields: FieldIndex;
  /**
   * Lines evicted from the head since the stream started. Anything above
   * zero means the top of the buffer is no longer the top of the log —
   * which the viewer used to do silently.
   */
  dropped: number;
  /**
   * When a batch last landed, and the two ids that divide the buffer
   * into what arrived under intake and what arrived without it.
   *
   * They exist because intake makes silence and rates ambiguous. The
   * first lets a quiet pane say how long it has been quiet instead of
   * looking dead. The other two bound the last unfiltered stretch —
   * `[unfilteredFrom, intakeFrom)` — which is the only part of the
   * buffer that can answer "how fast is this pod writing", since the
   * lines intake rejects never reach this process at all.
   */
  lastBatchAt: number;
  intakeFrom: number;
  unfilteredFrom: number;
  /** True while at least one container's stream is attached. */
  isStreaming: boolean;
  isConnecting: boolean;
  /**
   * Why a stream is not running, per container. A sidecar exiting kills
   * its stream and leaves the other four attached, so this is a list and
   * not a single verdict.
   */
  failures: ContainerFailure[];
  isPaused: boolean;
  clearLogs: () => void;
  togglePause: () => void;
  retry: () => void;
}

const NO_INTAKE: QueryTerm[] = [];
/** What `intakeKey` reads as when nothing is being kept at the source. */
const NO_INTAKE_KEY = JSON.stringify(NO_INTAKE);

export function useLogStream({
  podName,
  namespace,
  containers,
  limit,
  intake = NO_INTAKE,
}: UseLogStreamOptions): UseLogStreamResult {
  const [buffer, setBuffer] = useState<LogBuffer>(emptyBuffer);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [failures, setFailures] = useState<ContainerFailure[]>([]);
  const [isPaused, setIsPaused] = useState(false);
  const [retryTrigger, setRetryTrigger] = useState(0);
  const [lastBatchAt, setLastBatchAt] = useState(() => Date.now());
  const [intakeFrom, setIntakeFrom] = useState(0);
  const [unfilteredFrom, setUnfilteredFrom] = useState(0);

  const nextIdRef = useRef(0);

  // Callers build this array inline (`pod.containers.map(c => c.name)`),
  // so its identity changes every render. Depending on it directly would
  // restart every stream on every render.
  const containerKey = containers.join("\u0000");
  const streamed = useMemo(
    () => (containerKey === "" ? [] : containerKey.split("\u0000")),
    [containerKey]
  );

  // The same trick one level up: the intake array is rebuilt by a filter
  // in the viewer, so its identity moves on every render while its
  // contents do not. Serialised, the effect below restarts on a real
  // change and on nothing else.
  const intakeKey = JSON.stringify(intake);
  const intakeTerms = useMemo(
    () => JSON.parse(intakeKey) as QueryTerm[],
    [intakeKey]
  );

  /** What the attached streams were opened against. See `resuming` below. */
  const opened = useRef<{ target: string; intake: string } | null>(null);
  const target = `${namespace}/${podName}|${containerKey}|${limit}`;

  const clearLogs = useCallback(() => {
    setBuffer(emptyBuffer());
  }, []);

  const togglePause = useCallback(() => {
    setIsPaused((prev) => !prev);
  }, []);

  const retry = useCallback(() => {
    setFailures([]);
    setIsPaused(false);
    setRetryTrigger((prev) => prev + 1);
  }, []);

  useEffect(() => {
    let active = true;
    const unlistens: Array<() => void> = [];
    /** stream id -> container, and the set of streams still alive. */
    const containerOf = new Map<string, string>();
    const live = new Set<string>();
    /** Last timestamp seen per stream, so an untimestamped line sorts where it arrived. */
    const lastEpoch = new Map<string, number>();

    let pending: StreamedLogLine[] = [];
    let releaseTimer: ReturnType<typeof setTimeout> | null = null;

    const release = () => {
      if (releaseTimer !== null) {
        clearTimeout(releaseTimer);
        releaseTimer = null;
      }
      if (pending.length === 0 || !active) return;
      const window = orderByTimestamp(pending);
      pending = [];
      setBuffer((prev) => appendCapped(prev, window, limit));
      setLastBatchAt(Date.now());
    };

    const stopAll = async () => {
      const ids = [...containerOf.keys()];
      containerOf.clear();
      live.clear();
      await Promise.all(
        ids.map((id) =>
          commands
            .stopLogStream(id)
            .catch((err) => console.error("Failed to stop log streaming:", err))
        )
      );
    };

    const cleanup = async () => {
      active = false;
      if (releaseTimer !== null) clearTimeout(releaseTimer);
      releaseTimer = null;
      pending = [];
      while (unlistens.length > 0) unlistens.pop()!();
      await stopAll();
      setIsStreaming(false);
      setIsConnecting(false);
    };

    const initStreams = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!active || isPaused || streamed.length === 0) return;

      /**
       * Picking up where the buffer left off, rather than starting a
       * session. Two ways in, and the same handling for both:
       *
       * The reader flipped a chip — the lines already held were kept
       * under the old rule and stay, because the new rule is about what
       * arrives. Or intake is set and the stream is being reattached
       * after a pause or a break — where a backfill is worse than
       * useless, since `tailLines` is applied by the apiserver *before*
       * intake sees the lines, so a narrow intake would answer a wipe of
       * the buffer with a handful of survivors out of the last N.
       *
       * Either way there is no backfill: what it would return is the
       * tail the buffer already holds, as duplicates.
       */
      const previous = opened.current;
      const resuming =
        previous !== null &&
        previous.target === target &&
        (previous.intake !== intakeKey || intakeTerms.length > 0);
      opened.current = { target, intake: intakeKey };

      setIsConnecting(true);
      setFailures([]);
      if (!resuming) setBuffer(emptyBuffer());
      // The next line to arrive is the first one under whatever this
      // restart changed, so the boundaries move on the transitions and
      // not on every restart: an intake edited while it is already on
      // must not move the mark that says where unfiltered lines end, or
      // the arriving rate would start measuring already-filtered ones.
      const hadIntake = resuming && previous.intake !== NO_INTAKE_KEY;
      const hasIntake = intakeTerms.length > 0;
      if (!resuming || (hasIntake && !hadIntake)) {
        setIntakeFrom(nextIdRef.current);
      }
      if (!resuming || (!hasIntake && hadIntake)) {
        setUnfilteredFrom(nextIdRef.current);
      }
      // The clock on the silence starts at the attach rather than at
      // whenever the old stream last said something.
      setLastBatchAt(Date.now());

      // One listener pair for every container's stream, installed before
      // any of them is released. The backend holds each stream shut until
      // its `logStreamSubscribed` call, and Tauri events have no replay,
      // so a listener registered after the gate loses whatever was
      // emitted in between — including a stream that failed on its first
      // read. Registering once up front makes the gate hold for every
      // stream started below, however many there are.
      let unlistenBatch: (() => void) | null = null;
      let unlistenFailure: (() => void) | null = null;
      try {
        unlistenBatch = await listen<LogBatchPayload>("log-batch", (event) => {
          const container = containerOf.get(event.payload.stream_id);
          if (container === undefined || event.payload.lines.length === 0) {
            return;
          }

          let epoch = lastEpoch.get(event.payload.stream_id) ?? Date.now();
          for (const line of event.payload.lines) {
            if (line.timestamp) {
              const parsed = Date.parse(line.timestamp);
              if (!Number.isNaN(parsed)) epoch = parsed;
            }
            const streamedLine: StreamedLogLine = {
              id: nextIdRef.current++,
              epoch,
              groupKey: "",
              timestamp: line.timestamp,
              message: line.message,
              level: line.level,
              format: line.format ?? "plain",
              fields: line.fields,
              raw: line.raw || line.message,
              pod: podName,
              container,
              namespace,
            };
            streamedLine.groupKey = groupKeyFor(streamedLine);
            pending.push(streamedLine);
          }
          lastEpoch.set(event.payload.stream_id, epoch);

          if (pending.length >= MAX_PENDING_LINES) {
            release();
          } else if (releaseTimer === null) {
            releaseTimer = setTimeout(release, REORDER_WINDOW_MS);
          }
        });

        unlistenFailure = await listenForStreamFailures((streamId, failure) => {
          const container = containerOf.get(streamId);
          if (!active || container === undefined) return;
          live.delete(streamId);
          setFailures((prev) =>
            prev.some((f) => f.container === container)
              ? prev
              : [...prev, { ...failure, container }]
          );
          if (live.size === 0) {
            setIsStreaming(false);
            setIsConnecting(false);
          }
        });
      } catch (err) {
        unlistenBatch?.();
        unlistenFailure?.();
        if (!active) return;
        console.error("Failed to listen for log events:", err);
        setFailures(
          streamed.map((container) => ({
            container,
            kind: "broken" as const,
            message: normalizeTauriError(err),
          }))
        );
        setIsConnecting(false);
        return;
      }

      if (!active) {
        unlistenBatch();
        unlistenFailure();
        return;
      }
      unlistens.push(unlistenBatch, unlistenFailure);

      const started = await Promise.all(
        streamed.map(async (container) => {
          const config: StreamLogConfig = {
            podName,
            namespace,
            container,
            tailLines: resuming
              ? 0
              : backfillPerContainer(limit, streamed.length),
            follow: true,
            timestamps: true,
            previous: false,
            sinceSeconds: null,
            sinceTime: null,
            intake: intakeTerms,
          };

          try {
            const streamId = await commands.streamPodLogs(config);
            containerOf.set(streamId, container);
            live.add(streamId);

            if (!active) return false;

            // Listeners are installed — release the backend gate.
            // See `commands::logs::stream_pod_logs`.
            await commands.logStreamSubscribed(streamId);
            return true;
          } catch (err) {
            console.error(`Failed to stream logs of ${container}:`, err);
            if (!active) return false;
            const message = normalizeTauriError(err);
            setFailures((prev) => [
              ...prev,
              {
                container,
                kind:
                  message.includes("not found") || message.includes("NotFound")
                    ? "gone"
                    : "broken",
                message,
              },
            ]);
            return false;
          }
        })
      );

      if (!active) {
        await stopAll();
        return;
      }

      setIsConnecting(false);
      setIsStreaming(started.some(Boolean));
    };

    initStreams();

    return () => {
      cleanup();
    };
  }, [
    streamed,
    limit,
    podName,
    namespace,
    isPaused,
    retryTrigger,
    intakeKey,
    intakeTerms,
    target,
  ]);

  return {
    logs: buffer.lines,
    retained: buffer.lines.length,
    limit,
    fields: buffer.fields,
    dropped: buffer.dropped,
    lastBatchAt,
    intakeFrom,
    unfilteredFrom,
    isStreaming,
    isConnecting,
    failures,
    isPaused,
    clearLogs,
    togglePause,
    retry,
  };
}
