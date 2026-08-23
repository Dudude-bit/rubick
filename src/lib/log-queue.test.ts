import { beforeEach, describe, expect, it, vi } from "vitest";

const logFrontendEventsBatch = vi.fn<() => Promise<void>>();
vi.mock("@/lib/commands", () => ({
  commands: { logFrontendEventsBatch: () => logFrontendEventsBatch() },
}));

import { logQueue } from "./log-queue";

/**
 * A failed send used to be recorded twice. `sendBatch` queued every entry for
 * retry and then threw, and its one caller — which owns the retry policy —
 * queued them again on the way out, so one failure left two entries behind
 * and the next attempt doubled them again.
 */
describe("what a failed send leaves behind", () => {
  beforeEach(() => {
    logFrontendEventsBatch.mockReset();
    vi.useFakeTimers();
  });

  it("records each entry for retry once", async () => {
    logFrontendEventsBatch.mockRejectedValue(new Error("backend is down"));

    logQueue.enqueue({ level: "error", message: "one" });
    await logQueue.flush();

    expect(logQueue.getStatus().failedCount).toBe(1);
    vi.useRealTimers();
  });
});
