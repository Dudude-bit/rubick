import { LONG_TASK_MS, perf } from "@/lib/perf";
import type { PerfRecorder } from "@/lib/perf";

/** The slice of `window` the watch needs, so a test can hand in a fake. */
export interface FrameHost {
  performance: { now(): number };
  requestAnimationFrame(cb: (now: number) => void): number;
  cancelAnimationFrame(handle: number): void;
  PerformanceObserver?: typeof PerformanceObserver;
  /** Where the watch hears that the page stopped being painted. */
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
  document?: { visibilityState: string };
}

/** One frame at 60 Hz; a gap this long is a frame, not a stall. */
const FRAME_MS = 16.7;

/**
 * Long tasks, from whichever source this webview offers. Chromium-based
 * webviews report `longtask` entries; WebKit does not, and there the only
 * evidence of a blocked main thread is a frame that arrives late, so a
 * requestAnimationFrame loop watches the gap between frames instead.
 */
/** Where a late frame is written: the recorder while it runs, the stall watch always. */
export type TaskSink = Pick<PerfRecorder, "record" | "taskSource">;

export function startFrameWatch(
  recorder: TaskSink = perf,
  host: FrameHost = window
): () => void {
  const Observer = host.PerformanceObserver;
  if (Observer && (Observer.supportedEntryTypes ?? []).includes("longtask")) {
    recorder.taskSource = "longtask";
    const observer = new Observer((list) => {
      for (const entry of list.getEntries()) {
        recorder.record({
          kind: "task",
          name: "longtask",
          ms: entry.duration,
          at: entry.startTime + entry.duration,
        });
      }
    });
    observer.observe({ type: "longtask", buffered: false });
    return () => observer.disconnect();
  }

  recorder.taskSource = "frame-gap";
  let last = host.performance.now();
  let handle = 0;
  // A hidden, minimised or occluded window is not painted, so no frame runs
  // and the first one back carries the whole absence. That is not a
  // measurement of the main thread — it is the one period the watch could not
  // look at it — and reporting it as a stall put "the longest 299 983 ms" in
  // front of a reader who had merely minimised the window over lunch, with
  // advice to narrow their namespace scope. The gap across a return is
  // dropped rather than guessed at.
  let wasAway = host.document?.visibilityState === "hidden";
  const onVisibility = () => {
    if (host.document?.visibilityState === "hidden") wasAway = true;
  };
  host.addEventListener?.("visibilitychange", onVisibility);

  const tick = (now: number) => {
    const gap = now - last;
    if (wasAway) {
      wasAway = false;
    } else if (gap > LONG_TASK_MS + FRAME_MS) {
      recorder.record({
        kind: "task",
        name: "frame-gap",
        ms: gap - FRAME_MS,
        at: now,
      });
    }
    last = now;
    handle = host.requestAnimationFrame(tick);
  };
  handle = host.requestAnimationFrame(tick);
  return () => {
    host.removeEventListener?.("visibilitychange", onVisibility);
    host.cancelAnimationFrame(handle);
  };
}
