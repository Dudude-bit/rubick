import { describe, expect, it } from "vite-plus/test";

import { PerfRecorder } from "./perf";
import { PerfSession } from "./perf-session";

function harness(opts: { failStop?: boolean; failCounters?: boolean } = {}) {
  const recorder = new PerfRecorder();
  const calls: string[] = [];
  let watching = 0;
  let timingNavigations = 0;
  const session = new PerfSession(
    recorder,
    {
      setRecording: async (on) => {
        calls.push(`set:${on}`);
        if (!on && opts.failStop) {
          throw new Error(
            "Tauri command 'perfSetRecording' failed: bridge down"
          );
        }
      },
      counters: async () => {
        calls.push("counters");
        if (opts.failCounters) throw new Error("no counters");
        return {
          eventsEmitted: 3,
          eventBytes: 300,
          maxEventBytes: 200,
          watchChanges: 1,
        };
      },
    },
    () => {
      watching++;
      return () => {
        watching--;
      };
    },
    () => {
      timingNavigations++;
      return () => {
        timingNavigations--;
      };
    }
  );
  return {
    recorder,
    session,
    calls,
    watch: () => watching,
    navigations: () => timingNavigations,
  };
}

describe("PerfSession", () => {
  /** Navigations timed only while a panel was open would miss every one the reader made after closing it. */
  it("times navigations for exactly the length of the recording", async () => {
    const { session, navigations } = harness();
    await session.start();
    expect(navigations()).toBe(1);
    await session.stop();
    expect(navigations()).toBe(0);
  });

  /** A frame watch tied to the panel dies when Settings closes, mid-measurement. */
  it("owns the frame watch for the whole recording, not the panel's lifetime", async () => {
    const h = harness();
    await h.session.start();
    expect(h.watch()).toBe(1);
    expect(h.recorder.recording).toBe(true);
    await h.session.stop();
    expect(h.watch()).toBe(0);
    expect(h.recorder.recording).toBe(false);
    expect(h.recorder.backend?.eventsEmitted).toBe(3);
    expect(h.calls).toEqual(["set:true", "counters", "set:false"]);
  });

  /** A stop pressed while the start is still talking to the backend must wait, not race past it. */
  it("runs a stop after a start that was still in flight", async () => {
    const h = harness();
    const starting = h.session.start();
    const stopping = h.session.stop();
    await Promise.all([starting, stopping]);
    expect(h.session.current.phase).toBe("stopped");
    expect(h.watch()).toBe(0);
    expect(h.calls).toEqual(["set:true", "counters", "set:false"]);
  });

  /** A backend still serialising every event after a failed stop is a cost the panel must show — in the backend's words: `String(error)` put "Error: Tauri command 'perfSetRecording' failed:" in front of them. */
  it("keeps the failure of a backend stop visible and lets it be retried", async () => {
    const h = harness({ failStop: true });
    await h.session.start();
    await h.session.stop();
    expect(h.session.current).toEqual({
      phase: "stopped",
      error: "bridge down",
    });
    expect(h.recorder.recording).toBe(false);
    await h.session.retryBackendStop();
    expect(h.session.current.error).toBe("bridge down");
  });

  /** Counters that could not be read must not stop the recording from stopping. */
  it("stops even when the backend counters cannot be read, and says so", async () => {
    const h = harness({ failCounters: true });
    await h.session.start();
    await h.session.stop();
    expect(h.recorder.recording).toBe(false);
    expect(h.recorder.backend).toBeUndefined();
    expect(h.session.current.phase).toBe("stopped");
    expect(h.session.current.error).toContain("no counters");
  });
});
