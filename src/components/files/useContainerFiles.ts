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
  partial: boolean;
  unreadable: number;
  elapsed_ms: number;
}

export type FailureReason =
  "noTools" | "unopenable" | "refused" | "notRunning" | "failed";

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
      /** Which rung answered, or null when Stop came before it had said. */
      with: ListedWith | null;
      /** How long it took, or null when nobody recorded the start. */
      elapsedMs: number | null;
      at: number;
      /** The person pressed Stop; what arrived is not the whole directory. */
      stopped: boolean;
      /** The listing was cut short by the row cap, so this is not all of it. */
      partial: boolean;
      /**
       * Lines the parser could not read, so the count is not the whole —
       * or null when the backend has not answered yet. Zero is a claim.
       */
      unreadable: number | null;
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
  const stopWanted = useRef(false);

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
    stopWanted.current = false;
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
        if (!active || stopWanted.current) {
          void commands.stopFilesListing(id).catch(() => {});
          if (!active) return;
        }
        streamId = id;
        streamRef.current = stopWanted.current ? null : id;
        setSnapshot({
          key,
          state: { phase: "reading", entries: EMPTY, startedAt: Date.now() },
        });

        const onBatch = await listen<BatchPayload>("files-batch", (event) => {
          if (event.payload.stream_id !== id) return;
          setSnapshot(
            only((was) => {
              // The backend flushes its last batch *after* the cancel, and
              // by then `stop()` has already moved this to "done" — so
              // testing only for "reading" threw those rows away and the
              // tab said fewer had arrived than the reader had watched
              // arrive. No batch ever follows `files-done` for a stream id.
              if (was.phase !== "reading" && was.phase !== "done") return was;
              return {
                ...was,
                entries: [...was.entries, ...event.payload.entries],
              };
            })
          );
        });
        const onDone = await listen<DonePayload>("files-done", (event) => {
          if (event.payload.stream_id !== id) return;
          setSnapshot(
            only((was) => ({
              phase: "done",
              // The backend emits `files-done` after a cancel too, and by
              // then `stop()` has already moved the state to "done" — so
              // testing for "reading" threw away every row that had arrived
              // and the tab announced the directory as empty.
              entries:
                was.phase === "reading" || was.phase === "done"
                  ? was.entries
                  : EMPTY,
              with: event.payload.with,
              elapsedMs: event.payload.elapsed_ms,
              at: Date.now(),
              // A listing the reader cut short stays cut short. Overwriting
              // this relabelled a partial read as the whole directory.
              stopped: was.phase === "done" ? was.stopped : false,
              partial: event.payload.partial,
              unreadable: event.payload.unreadable,
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
                // Whatever arrived is what the reader saw arrive; a failure
                // at the end does not unsee it. Wiping the rows here turned
                // a stop-then-fail into "nothing was ever read".
                entries:
                  was.phase === "reading" || was.phase === "done"
                    ? was.entries
                    : EMPTY,
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
    // Pressed before `listContainerFiles` has answered, the button used to
    // do nothing at all — not even record that it had been pressed — and
    // the read went on. The intent is kept; the subscribe path honours it
    // the moment it has an id.
    stopWanted.current = true;
    const id = streamRef.current;
    if (id) {
      streamRef.current = null;
      void commands.stopFilesListing(id).catch(() => {});
    }
    setSnapshot((was) =>
      was.state.phase === "reading"
        ? {
            key: was.key,
            state: {
              phase: "done",
              entries: was.state.entries,
              // Nothing has said which rung answered, how long it took, or
              // how many lines it could not read. `files-done` follows and
              // fills them in; until it does they are unknown, not
              // "gnuFind", not 0.
              with: null,
              elapsedMs:
                was.state.startedAt === 0
                  ? null
                  : Date.now() - was.state.startedAt,
              at: Date.now(),
              stopped: true,
              partial: true,
              unreadable: null,
            },
          }
        : was
    );
  }, []);

  const reload = useCallback(() => setGeneration((g) => g + 1), []);

  return { state, stop, reload };
}
