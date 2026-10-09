import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  CRASH_LOOP_WINDOW_MS,
  loopingNow,
  loopState,
  seenLoop,
  withKnownLoop,
} from "./crash-loop";

interface Case {
  name: string;
  now: string;
  display: string;
  loopingUntil: string | null;
  looping: boolean;
  exitUnreported: boolean;
}

const shared = JSON.parse(
  readFileSync(resolve(process.cwd(), "src/contracts/crash-loop.json"), "utf8")
) as { windowSeconds: number; cases: Case[] };

describe("the crash-loop window", () => {
  /** The backend counts the same pods crash-looping on the Overview; fails
   *  if this side's window moves away from the shared file. */
  it("matches src/contracts/crash-loop.json", () => {
    expect(CRASH_LOOP_WINDOW_MS).toBe(shared.windowSeconds * 1000);
  });

  /** The backend ships each case's row; fails if this side reads one of
   *  them otherwise than `crash_looping` and `exit_unreported` do. */
  it.each(shared.cases.map((c) => [c.name, c] as const))(
    "reads %s as the shared file says",
    (_, c) => {
      const status = {
        display: c.display,
        loopingUntil: c.loopingUntil ?? undefined,
        exitUnreported: c.exitUnreported,
      };
      expect(loopState(status, Date.parse(c.now))).toBe(
        c.looping ? "looping" : c.exitUnreported ? "unreported" : "clear"
      );
    }
  );

  /** Fails if a pod whose loop has lapsed is called one, or one before
   *  that moment is not. */
  it("reads a loop only until the moment the backend ships", () => {
    const now = Date.parse("2026-10-08T20:45:50Z");
    const lapses = (ms: number) => ({
      loopingUntil: new Date(now + ms).toISOString(),
    });
    expect(loopingNow(lapses(60_000), now)).toBe(true);
    expect(loopingNow(lapses(0), now)).toBe(false);
    expect(loopingNow({}, now)).toBe(false);
  });
});

describe("a loop the kubelet stopped reporting the exit of", () => {
  const now = Date.parse("2026-10-09T04:37:47Z");
  const unreported: {
    uid: string;
    restartCount: number;
    status: {
      display: string;
      exitUnreported: boolean;
      loopingUntil?: string;
    };
  } = {
    uid: "fwk7g",
    restartCount: 15,
    status: { display: "Running", exitUnreported: true },
  };
  const backOff = (at: string, message: string) => ({
    reason: "BackOff",
    message,
    lastTimestamp: at,
  });

  /**
   * Sam's pod page caught checkout green Running the moment the kubelet
   * dropped its lastState, after showing it crash-looping all along. Fails
   * if a loop this page saw, with no fewer restarts since, or a recent
   * back-off of a failed container, stops carrying the loop across that
   * read, or if an image pull back-off or another pod's loop is taken for
   * one.
   */
  it("carries the loop from what was seen before or from the kubelet backing off", () => {
    const seen = seenLoop(
      {
        uid: "fwk7g",
        restartCount: 14,
        status: { display: "Running", loopingUntil: "2026-10-09T04:42:43Z" },
      },
      null,
      now
    );
    const carried = withKnownLoop(unreported, seen, []);
    expect(carried.status.loopingUntil).toBe("2026-10-09T04:42:43.000Z");
    expect(loopState(carried.status, now)).toBe("looping");

    const evented = withKnownLoop(unreported, null, [
      backOff(
        "2026-10-09T04:34:00Z",
        "Back-off restarting failed container app in pod checkout-7596d7fc77-fwk7g_shop"
      ),
    ]);
    expect(loopState(evented.status, now)).toBe("looping");

    expect(
      withKnownLoop(unreported, { ...seen!, uid: "other" }, [
        backOff(
          "2026-10-09T04:34:00Z",
          'Back-off pulling image "busybox:1.36"'
        ),
      ])
    ).toBe(unreported);
    expect(loopState(unreported.status, now)).toBe("unreported");
  });

  /** Fails if a pod seen in CrashLoopBackOff with no exit at all is not
   *  remembered from the moment it was first seen, or a read with nothing
   *  new replaces what was remembered, which would redraw the page forever. */
  it("remembers a back-off seen with no exit from the moment it was first seen", () => {
    const backingOff = {
      uid: "fwk7g",
      restartCount: 15,
      status: { display: "CrashLoopBackOff" },
    };
    const first = seenLoop(backingOff, null, now);
    expect(first).toEqual({
      uid: "fwk7g",
      until: new Date(now + CRASH_LOOP_WINDOW_MS).toISOString(),
      restarts: 15,
    });
    expect(seenLoop(backingOff, first, now + 5_000)).toBe(first);
    expect(seenLoop(unreported, first, now + 5_000)).toBe(first);
  });
});
