import { describe, expect, it } from "vitest";

import { PerfRecorder } from "./perf";
import { startFrameWatch } from "./perf-frames";

function fakeWindow(now: { value: number }) {
  const frames: FrameRequestCallback[] = [];
  const listeners: Record<string, Array<() => void>> = {};
  const doc = { visibilityState: "visible" };
  const win = {
    document: doc,
    addEventListener: (type: string, listener: () => void) => {
      (listeners[type] ??= []).push(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners[type] = (listeners[type] ?? []).filter((l) => l !== listener);
    },
    performance: { now: () => now.value },
    requestAnimationFrame: (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    },
    cancelAnimationFrame: () => {
      frames.length = 0;
    },
  };
  const frame = (at: number) => {
    now.value = at;
    const cb = frames.shift();
    cb?.(at);
  };
  /** What the webview sends when the window goes away and comes back. */
  const away = () => {
    doc.visibilityState = "hidden";
    for (const l of listeners.visibilitychange ?? []) l();
    doc.visibilityState = "visible";
    for (const l of listeners.visibilitychange ?? []) l();
  };
  return { win, frame, away };
}

describe("startFrameWatch without a longtask observer", () => {
  /** A stall that never became a sample would leave the report claiming a smooth run. */
  it("records a late frame as a task and says which source it used", () => {
    const now = { value: 0 };
    const { win, frame } = fakeWindow(now);
    const r = new PerfRecorder();
    r.start(0);
    const stop = startFrameWatch(r, win);
    frame(16);
    frame(33);
    frame(233);
    stop();
    const report = r.report(233);
    expect(report?.taskSource).toBe("frame-gap");
    expect(report?.tasks?.count).toBe(1);
    expect(Math.round(report?.tasks?.max ?? 0)).toBe(183);
  });

  /** Frames at 60 Hz are not stalls; counting them would drown the real ones. */
  it("ignores ordinary frames", () => {
    const now = { value: 0 };
    const { win, frame } = fakeWindow(now);
    const r = new PerfRecorder();
    r.start(0);
    const stop = startFrameWatch(r, win);
    for (let t = 16; t <= 160; t += 16) frame(t);
    stop();
    expect(r.count("task")).toBe(0);
  });

  /**
   * A window nobody was looking at is not a window that froze.
   *
   * `requestAnimationFrame` does not run while the page is hidden, minimised
   * or occluded, so the first frame back carries the whole absence. Recorded
   * as a gap it became "1 stall, the longest 299 983 ms" after a five-minute
   * lunch, on every install, with advice to narrow the namespace scope.
   * Fails if the watch goes back to timing the dark.
   */
  it("does not count the time the window was not being painted", () => {
    const now = { value: 0 };
    const { win, frame, away } = fakeWindow(now);
    const r = new PerfRecorder();
    r.start(0);
    const stop = startFrameWatch(r, win);
    frame(16);
    away();
    frame(300_016);
    stop();
    expect(r.count("task")).toBe(0);
  });

  /**
   * The discount is for the one frame that spans the absence, not for every
   * frame after it. Forgiving them all would mean a window that had once been
   * minimised never reported a stall again — the watch turned off by a
   * gesture nobody connects to it.
   */
  it("goes back to timing stalls after the window returns", () => {
    const now = { value: 0 };
    const { win, frame, away } = fakeWindow(now);
    const r = new PerfRecorder();
    r.start(0);
    const stop = startFrameWatch(r, win);
    frame(16);
    away();
    frame(300_016);
    expect(r.count("task")).toBe(0);
    frame(300_516);
    stop();
    expect(r.count("task")).toBe(1);
  });
});
