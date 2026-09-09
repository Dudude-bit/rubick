import { LONG_TASK_MS, perf } from "@/lib/perf";
import type { PerfRecorder } from "@/lib/perf";

/** The slice of `window` the watch needs, so a test can hand in a fake. */
export interface FrameHost {
  performance: { now(): number };
  requestAnimationFrame(cb: (now: number) => void): number;
  cancelAnimationFrame(handle: number): void;
  PerformanceObserver?: typeof PerformanceObserver;
}

/** One frame at 60 Hz; a gap this long is a frame, not a stall. */
const FRAME_MS = 16.7;

/**
 * Long tasks, from whichever source this webview offers. Chromium-based
 * webviews report `longtask` entries; WebKit does not, and there the only
 * evidence of a blocked main thread is a frame that arrives late, so a
 * requestAnimationFrame loop watches the gap between frames instead.
 */
export function startFrameWatch(
  recorder: PerfRecorder = perf,
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
  const tick = (now: number) => {
    const gap = now - last;
    if (gap > LONG_TASK_MS + FRAME_MS) {
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
  return () => host.cancelAnimationFrame(handle);
}
