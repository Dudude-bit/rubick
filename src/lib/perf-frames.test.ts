import { describe, expect, it } from "vitest";

import { PerfRecorder } from "./perf";
import { startFrameWatch } from "./perf-frames";

function fakeWindow(now: { value: number }) {
  const frames: FrameRequestCallback[] = [];
  const win = {
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
  return { win, frame };
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
});
