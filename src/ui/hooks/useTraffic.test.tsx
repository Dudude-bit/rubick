import type { ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { FlowSource, TrafficReading } from "@/lib/traffic";

const capability = vi.fn();
vi.mock("@/integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/integrations")>()),
  useCapabilityState: () => capability(),
}));

const { sourcesRefresh, useTraffic } = await import("./useTraffic");

const source = (says: "present" | "absent"): FlowSource => ({
  id: "istio",
  name: "Istio",
  state: { says },
  measures: ["requests"],
  found: [],
  need: "needIstio",
  marks: true,
  nodeAgent: false,
});

const READING: TrafficReading = {
  sources: [source("present")],
  window: "5m",
  answer: {
    ends: [],
    flows: [],
    reads: [],
    observed: null,
    coverage: [],
    podsUnread: [],
    podsFailed: null,
    cut: 0,
  },
};

const sources = vi.fn<() => Promise<FlowSource[]>>();
const read = vi.fn<() => Promise<TrafficReading>>();
const ready = {
  state: "ready",
  vendor: "Prometheus",
  endpoint: "prom.example.com",
  use: { sources: () => sources(), read: () => read() },
  page: null,
};

function run() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    () => useTraffic({ scope: null, window: "5m", refresh: "scraped" }),
    { wrapper }
  );
}

beforeEach(() => {
  sources.mockReset();
  read.mockReset();
});

describe("reading traffic", () => {
  /**
   * Nothing connected, a probe still out, and an address that did not
   * answer each ask the supplier nothing at all.
   */
  it("asks nothing where no supplier is ready", () => {
    for (const [state, says] of [
      [{ state: "absent" }, "absent"],
      [{ state: "reading" }, "checking"],
      [
        {
          state: "unreachable",
          vendor: "Prometheus",
          endpoint: "p",
          reason: "refused",
        },
        "unreachable",
      ],
    ] as const) {
      capability.mockReturnValue(state);
      expect(run().result.current.says).toBe(says);
    }
    expect(sources).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  /** A supplier with no source is asked which sources it has and nothing more. */
  it("does not read flows from a supplier that holds no source", async () => {
    capability.mockReturnValue(ready);
    sources.mockResolvedValue([source("absent")]);
    const { result } = run();
    await waitFor(() => expect(result.current.says).toBe("noSource"));
    expect(read).not.toHaveBeenCalled();
  });

  /** A read that failed is a failure with the words, never "no source" or "no flows". */
  it("says a failed read as failed, with its words", async () => {
    capability.mockReturnValue(ready);
    sources.mockResolvedValue([source("present")]);
    read.mockRejectedValue(new Error("timed out after 20s"));
    const { result } = run();
    await waitFor(() => expect(result.current.says).toBe("failed"));
    expect(result.current).toMatchObject({ said: "timed out after 20s" });
  });

  /** A present source is read, and its answer is the state. */
  it("reads a present source", async () => {
    capability.mockReturnValue(ready);
    sources.mockResolvedValue([source("present")]);
    read.mockResolvedValue(READING);
    const { result } = run();
    await waitFor(() => expect(result.current.says).toBe("read"));
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("how often sources are asked about", () => {
  /**
   * Sources come with installs and are asked about rarely; one that could
   * not be looked for is asked again soon, or the rail says it failed for
   * minutes after Prometheus answers again.
   */
  it("asks again soon where a source could not be looked for", () => {
    const failed: FlowSource = {
      ...source("absent"),
      state: { says: "failed", said: "bad_data" },
    };
    expect(sourcesRefresh(undefined)).toBe("unserved");
    expect(sourcesRefresh([source("present"), source("absent")])).toBe(
      "unserved"
    );
    expect(sourcesRefresh([source("present"), failed])).toBe("steady");
  });

  /** And the hook asks at that rate: a failed source is looked for again within a minute. */
  it("looks for a failed source again without anyone reopening the page", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    try {
      capability.mockReturnValue(ready);
      sources.mockResolvedValue([
        { ...source("present"), state: { says: "failed", said: "bad_data" } },
      ]);
      run();
      await vi.waitFor(() => expect(sources).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(61_000);
      expect(sources.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
