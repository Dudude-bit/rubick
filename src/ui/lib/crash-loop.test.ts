import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { CRASH_LOOP_WINDOW_MS, loopingNow } from "./crash-loop";

describe("the crash-loop window", () => {
  /** The backend counts the same pods crash-looping on the Overview; fails
   *  if this side's window moves away from the shared file. */
  it("matches src/contracts/crash-loop.json", () => {
    const shared = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "src/contracts/crash-loop.json"),
        "utf8"
      )
    ) as { windowSeconds: number };
    expect(CRASH_LOOP_WINDOW_MS).toBe(shared.windowSeconds * 1000);
  });

  /** Fails if a pod with no recent loop is called one, or one inside the
   *  window is not. */
  it("reads a loop only inside the window from its last exit", () => {
    const now = Date.parse("2026-10-08T20:45:50Z");
    const ago = (ms: number) => ({
      loopingExitAt: new Date(now - ms).toISOString(),
    });
    expect(loopingNow(ago(60_000), now)).toBe(true);
    expect(loopingNow(ago(CRASH_LOOP_WINDOW_MS + 1), now)).toBe(false);
    expect(loopingNow({}, now)).toBe(false);
  });
});
