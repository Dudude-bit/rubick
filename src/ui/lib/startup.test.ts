import { beforeEach, describe, expect, it, vi } from "vitest";

const logInfo = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", () => ({ logInfo }));

describe("the startup line", () => {
  beforeEach(() => {
    vi.resetModules();
    logInfo.mockClear();
    performance.clearMarks();
  });

  /**
   * A mark never reached is null, not zero: a launch that never painted
   * would otherwise read as one that painted instantly.
   */
  it("reports the marks reached and null for the one that was not", async () => {
    const { markStartup, reportStartup } = await import("./startup");
    markStartup("main");
    markStartup("root");
    reportStartup();

    const data = logInfo.mock.calls[0][1].data;
    expect(typeof data.mainMs).toBe("number");
    expect(typeof data.rootMs).toBe("number");
    expect(data.paintedMs).toBeNull();
  });

  /** StrictMode runs the effect twice; the log gets one line per launch. */
  it("is written once however often it is asked", async () => {
    const { reportStartup } = await import("./startup");
    reportStartup();
    reportStartup();
    expect(logInfo).toHaveBeenCalledTimes(1);
  });
});
