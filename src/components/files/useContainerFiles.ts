import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import type { FileEntry, ListedWith } from "@/lib/container-files";
import type { Via } from "@/generated/types";

interface BatchPayload {
  stream_id: string;
  entries: FileEntry[];
}

interface DonePayload {
  stream_id: string;
  with: ListedWith;
  entries: number;
  elapsed_ms: number;
}

export type FailureReason = "noTools" | "refused" | "notRunning" | "failed";

interface FailedPayload {
  stream_id: string;
  reason: FailureReason;
  message: string;
  exit_code: number | null;
  stderr: string;
  tried: string[];
}

/**
 * Where a listing stands. Four states, and "reading" with no rows is not
 * "empty": the difference is the whole point of streaming the rows in.
 */
export type ListingState =
  | { phase: "idle" }
  | { phase: "reading"; entries: FileEntry[]; startedAt: number }
  | {
      phase: "done";
      entries: FileEntry[];
      with: ListedWith;
      elapsedMs: number;
      at: number;
      /** The person pressed Stop; what arrived is not the whole directory. */
      stopped: boolean;
    }
  | {
      phase: "failed";
      entries: FileEntry[];
      reason: FailureReason;
      message: string;
      exitCode: number | null;
      stderr: string;
      tried: string[];
    };

export interface ContainerFilesTarget {
  pod: string;
  namespace: string;
  container: string;
  path: string;
  via: Via | null;
  /**
   * The container's life, as `uid:restartCount`: a listing taken from one
   * life is not the state of the next, and the tab says so rather than
   * rereading on its own.
   */
  life: string;
}

const EMPTY: FileEntry[] = [];

/**
 * One directory listing, streamed. Subscribes, listens, releases the gate,
 * and stops the stream when the target changes or the tab goes away.
 */
export function useContainerFiles(target: ContainerFilesTarget | null): {
  state: ListingState;
  stop: () => void;
  reload: () => void;
} {
  const [generation, setGeneration] = useState(0);
  // The state is kept with the key it belongs to, so a new target reads as
  // "reading" from its first render without the effect writing state.
  const [snapshot, setSnapshot] = useState<{
    key: string | null;
    state: ListingState;
  }>({ key: null, state: { phase: "idle" } });
  const streamRef = useRef<string | null>(null);

  const key = target
    ? [
        target.namespace,
        target.pod,
        target.container,
        target.path,
        target.via?.container ?? "",
        target.via?.root ?? "",
        target.life,
        String(generation),
      ].join(" ")
    : null;

  const state: ListingState =
    key === null
      ? { phase: "idle" }
      : snapshot.key === key
        ? snapshot.state
        : { phase: "reading", entries: EMPTY, startedAt: 0 };

  useEffect(() => {
    if (!target || key === null) return;
    let active = true;
    let off: Array<() => void> = [];
    let streamId: string | null = null;
    const only =
      (update: (was: ListingState) => ListingState) =>
      (was: { key: string | null; state: ListingState }) =>
        was.key === key
          ? { key, state: update(was.state) }
          : {
              key,
              state: update({ phase: "reading", entries: EMPTY, startedAt: 0 }),
            };

    const takeDown = () => {
      for (const fn of off) fn();
      off = [];
      if (streamId) {
        const id = streamId;
        streamId = null;
        streamRef.current = null;
        void commands.stopFilesListing(id).catch(() => {});
      }
    };

    (async () => {
      try {
        const id = await commands.listContainerFiles(
          target.pod,
          target.namespace,
          target.container,
          target.path,
          target.via
        );
        if (!active) {
          void commands.stopFilesListing(id).catch(() => {});
          return;
        }
        streamId = id;
        streamRef.current = id;
        setSnapshot({
          key,
          state: { phase: "reading", entries: EMPTY, startedAt: Date.now() },
        });

        const onBatch = await listen<BatchPayload>("files-batch", (event) => {
          if (event.payload.stream_id !== id) return;
          setSnapshot(
            only((was) =>
              was.phase === "reading"
                ? {
                    ...was,
                    entries: [...was.entries, ...event.payload.entries],
                  }
                : was
            )
          );
        });
        const onDone = await listen<DonePayload>("files-done", (event) => {
          if (event.payload.stream_id !== id) return;
          setSnapshot(
            only((was) => ({
              phase: "done",
              entries: was.phase === "reading" ? was.entries : EMPTY,
              with: event.payload.with,
              elapsedMs: event.payload.elapsed_ms,
              at: Date.now(),
              stopped: false,
            }))
          );
        });
        const onFailed = await listen<FailedPayload>(
          "files-failed",
          (event) => {
            if (event.payload.stream_id !== id) return;
            setSnapshot(
              only((was) => ({
                phase: "failed",
                entries: was.phase === "reading" ? was.entries : EMPTY,
                reason: event.payload.reason,
                message: event.payload.message,
                exitCode: event.payload.exit_code,
                stderr: event.payload.stderr,
                tried: event.payload.tried,
              }))
            );
          }
        );
        off = [onBatch, onDone, onFailed];
        if (!active) {
          takeDown();
          return;
        }
        await commands.filesSubscribed(id);
      } catch (error) {
        if (!active) return;
        setSnapshot({
          key,
          state: {
            phase: "failed",
            entries: EMPTY,
            reason: "failed",
            message: normalizeTauriError(error),
            exitCode: null,
            stderr: "",
            tried: [],
          },
        });
      }
    })();

    return () => {
      active = false;
      takeDown();
    };
    // `target` is read through `key`: a new object with the same facts is
    // the same listing, and re-subscribing on it would restart the read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const stop = useCallback(() => {
    const id = streamRef.current;
    if (!id) return;
    streamRef.current = null;
    void commands.stopFilesListing(id).catch(() => {});
    setSnapshot((was) =>
      was.state.phase === "reading"
        ? {
            key: was.key,
            state: {
              phase: "done",
              entries: was.state.entries,
              with: "gnuFind",
              elapsedMs: Date.now() - was.state.startedAt,
              at: Date.now(),
              stopped: true,
            },
          }
        : was
    );
  }, []);

  const reload = useCallback(() => setGeneration((g) => g + 1), []);

  return { state, stop, reload };
}
