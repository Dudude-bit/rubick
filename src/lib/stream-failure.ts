import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Why a backend stream stopped without the frontend closing it.
 * Mirrors `state::events::StreamFailureKind`.
 *
 * `gone` is a fact about the cluster — the pod was deleted, the
 * container exited — and no retry undoes it. `broken` is a transport
 * failure over a resource that may well still be running, so the panel
 * that shows it owes the reader a way back.
 */
export type StreamFailureKind = "gone" | "broken";

export interface StreamFailure {
  kind: StreamFailureKind;
  message: string;
}

interface StreamFailedPayload {
  stream_id: string;
  kind: StreamFailureKind;
  message: string;
}

/**
 * Subscribe to `stream-failed` for one log stream or terminal session.
 *
 * The id is read through a callback rather than captured, because the
 * terminal has to be listening before `openPodShell` has told it which
 * session it owns.
 *
 * Registration must complete before the backend gate is released —
 * `logStreamSubscribed` / `terminalSubscribed` — for the same reason
 * `log-batch` must: Tauri events have no replay, so a failure emitted
 * before this resolves is lost and the panel falls back to its empty
 * state, which is the exact lie this event exists to stop telling.
 */
export function listenForStreamFailure(
  matchId: () => string | null,
  onFailure: (failure: StreamFailure) => void
): Promise<UnlistenFn> {
  return listenForStreamFailures((streamId, failure) => {
    if (streamId !== matchId()) return;
    onFailure(failure);
  });
}

/**
 * The same subscription for a caller that owns several streams at once —
 * the log viewer runs one per container — and has to know which of them
 * died. One registration covers all of them, which keeps the gate simple:
 * the listener is installed once, before the first stream is released,
 * and every later `logStreamSubscribed` is therefore covered too.
 */
export function listenForStreamFailures(
  onFailure: (streamId: string, failure: StreamFailure) => void
): Promise<UnlistenFn> {
  return listen<StreamFailedPayload>("stream-failed", (event) => {
    if (!event.payload.stream_id) return;
    onFailure(event.payload.stream_id, {
      kind: event.payload.kind,
      message: event.payload.message,
    });
  });
}
