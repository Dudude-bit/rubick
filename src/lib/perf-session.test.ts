import { describe, expect, it } from "vitest";

import { PerfRecorder } from "./perf";
import { PerfSession } from "./perf-session";

function harness(opts: { failStop?: boolean; failCounters?: boolean } = {}) {
  const recorder = new PerfRecorder();
  const calls: string[] = [];
  let watching = 0;
  const session = new PerfSession(
    recorder,
    {
      setRecording: async (on) => {
        calls.push(`set:${on}`);
        if (!on && opts.failStop) throw new Error("bridge down");
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
    }
  );
  return { recorder, session, calls, watch: () => watching };
}

describe("PerfSession", () => {
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

  /** A backend still serialising every event after a failed stop is a cost the panel must show. */
  it("keeps the failure of a backend stop visible and lets it be retried", async () => {
    const h = harness({ failStop: true });
    await h.session.start();
    await h.session.stop();
    expect(h.session.current).toEqual({
      phase: "stopped",
      error: "Error: bridge down",
    });
    expect(h.recorder.recording).toBe(false);
    await h.session.retryBackendStop();
    expect(h.session.current.error).toBe("Error: bridge down");
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
