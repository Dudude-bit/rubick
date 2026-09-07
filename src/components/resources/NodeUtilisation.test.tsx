import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { NodeUsageWindow } from "@/integrations";
import type { NodeInfo } from "@/generated/types";

const capability = vi.fn();

vi.mock("@/integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/integrations")>();
  return {
    ...actual,
    useCapabilityState: () => capability(),
  };
});

const { NodeUtilisation } = await import("./NodeUtilisation");

function wrap(node: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>
  );
}

function node(name: string, unschedulable = false): NodeInfo {
  return {
    name,
    uid: name,
    status: { ready: true, conditions: [], addresses: [] },
    roles: [],
    version: "v1.32.0",
    os: "linux",
    arch: "arm64",
    containerRuntime: "containerd://1.7",
    labels: {},
    taints: [],
    unschedulable,
    capacity: { cpu: "4", memory: "16Gi", pods: "110", ephemeralStorage: null },
    allocatable: {
      cpu: "4",
      memory: "16Gi",
      pods: "110",
      ephemeralStorage: null,
    },
    providerId: null,
    createdAt: null,
  };
}

const T0 = 1_700_000_000_000;
const GI = 1024 ** 3;

const window: NodeUsageWindow = {
  nodes: {
    hot: {
      cpuMillicores: [
        { t: T0, v: 1000 },
        { t: T0 + 60_000, v: 3600 },
      ],
      memoryBytes: [{ t: T0, v: 4 * GI }],
    },
    calm: {
      cpuMillicores: [{ t: T0, v: 400 }],
      memoryBytes: [{ t: T0, v: 2 * GI }],
    },
  },
  newestAt: { fresh: T0 - 4 * 60_000 },
  resolution: "30s buckets, max over a 15s resolution",
};

beforeEach(() => {
  capability.mockReturnValue({
    state: "ready",
    endpoint: "prometheus.monitoring:9090",
    vendor: "Prometheus",
    use: vi.fn(async () => window),
  });
});

describe("NodeUtilisation", () => {
  /** The busiest node first, its peak and average in words a reader can act on. */
  it("orders by headroom and prints peak and average as shares of allocatable", async () => {
    wrap(
      <NodeUtilisation
        nodes={[node("calm"), node("hot")]}
        range="6h"
        onRange={() => {}}
      />
    );
    await screen.findByText("peak 90% · avg 58%");
    const rows = screen.getAllByRole("row");
    // Header row first, then the nodes.
    expect(rows[1]).toHaveTextContent("hot");
    expect(rows[1]).toHaveTextContent("peak 90% · avg 58%");
    expect(rows[2]).toHaveTextContent("calm");
    expect(rows[2]).toHaveTextContent("peak 10% · avg 10%");
  });

  /** A node drawn at zero because Prometheus has not heard from it yet is the lie this view exists to avoid. */
  it("says a node without series has none, with how old its newest sample is", async () => {
    wrap(
      <NodeUtilisation
        nodes={[node("fresh"), node("hot")]}
        range="24h"
        onRange={() => {}}
      />
    );
    await screen.findByText(/no samples in the window/);
    const rows = screen.getAllByRole("row");
    expect(rows[2]).toHaveTextContent("fresh");
    expect(rows[2]).toHaveTextContent(/no samples in the window/);
    expect(rows[2]).toHaveTextContent(/the window asks for 24h/);
    expect(rows[2]).not.toHaveTextContent("peak 0%");
  });

  it("marks a cordoned node as a decision rather than a fault", async () => {
    wrap(
      <NodeUtilisation
        nodes={[node("calm", true)]}
        range="6h"
        onRange={() => {}}
      />
    );
    await screen.findByText(/peak 10%/);
    const rows = screen.getAllByRole("row");
    expect(rows[1]).toHaveTextContent("cordoned");
  });

  it("offers a Prometheus when there is none rather than an empty table", () => {
    capability.mockReturnValue({ state: "absent" });
    wrap(
      <NodeUtilisation nodes={[node("calm")]} range="6h" onRange={() => {}} />
    );
    expect(screen.getByText(/needs a Prometheus/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
