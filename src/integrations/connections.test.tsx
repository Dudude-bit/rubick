import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/commands", () => ({
  commands: {
    detectInClusterExtensions: vi.fn(async () => []),
    getPrometheusConnection: vi.fn(async () => ({
      url: "http://localhost:20001",
      authType: "none",
      hasToken: false,
      insecureTls: false,
    })),
    probePrometheus: vi.fn(async () => ({
      ok: true,
      at: 1,
      latencyMs: 5,
      version: "2.53.0",
      reason: null,
    })),
    getLokiConnection: vi.fn(async () => null),
  },
}));

import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import { useIntegrations } from "./index";

/**
 * A probe is a question to the cluster's tunnel, and it must only be asked
 * while there is a cluster to carry it. It used to fire in the window
 * between a session ending and the next one landing — the failure came
 * back as an answer, not an error, and "did not answer — No cluster is
 * connected" sat on the row long after the reconnect stood.
 */
describe("the configured vendors' probe", () => {
  let client: QueryClient;

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    vi.mocked(commands.probePrometheus).mockClear();
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    useClusterStore.setState({
      currentContext: "prod-eu",
      isConnected: true,
    });
  });

  afterEach(() => {
    useClusterStore.setState({ isConnected: false, currentContext: null });
  });

  it("asks only while connected, and asks again once the next session lands", async () => {
    renderHook(() => useIntegrations({ facts: false }), { wrapper });
    await waitFor(() =>
      expect(commands.probePrometheus).toHaveBeenCalledTimes(1)
    );

    // The session ends; a flush arrives (the connection-landing invalidation
    // is global). The probe must not be asked of a disconnected app — that
    // answer would be a failure that outlives the outage.
    act(() => useClusterStore.setState({ isConnected: false }));
    await act(() => client.invalidateQueries());
    expect(commands.probePrometheus).toHaveBeenCalledTimes(1);

    // The next landing re-enables it, and stale means it is asked again.
    act(() => useClusterStore.setState({ isConnected: true }));
    await waitFor(() =>
      expect(commands.probePrometheus).toHaveBeenCalledTimes(2)
    );
  });
});
