import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  ScreenShareProvider,
  useScreenSections,
} from "@/components/share/screen-share";
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
  basis: "node",
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

  /**
   * Nine cells saying "no series" told the reader nothing. When no node has
   * a series on either basis the reason is said once, with what was asked
   * and where to look, and the cells stay quiet. Fails if the block is lost
   * or the cells go back to repeating it.
   */
  it("says once, above the table, that no node has a series on either basis", async () => {
    capability.mockReturnValue({
      state: "ready",
      endpoint: "localhost:20000",
      vendor: "Prometheus",
      page: "/integrations/prometheus?tab=monitors",
      use: vi.fn(async () => ({
        nodes: {},
        newestAt: {},
        newestKnown: true,
        basis: "pods",
        resolution: "3m buckets",
      })),
    });
    wrap(
      <NodeUtilisation
        nodes={[node("a"), node("b"), node("c")]}
        range="6h"
        onRange={() => {}}
      />
    );
    const block = await screen.findByText(
      "No node has a CPU or memory series in Prometheus"
    );
    expect(screen.getAllByText(block.textContent ?? "")).toHaveLength(1);
    expect(
      screen.getByText("container_cpu_usage_seconds_total")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Prometheus › Monitors" })
    ).toHaveAttribute("href", "/integrations/prometheus?tab=monitors");
    expect(screen.queryByText("no series")).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Note" })).toBeNull();
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(rows[1]).toHaveTextContent("–");
  });

  /**
   * A refused window is "could not look" on every row, never the all-silent
   * block. Fails if the collapse stops checking that the window was read.
   */
  it("says it could not look, not that there are no series, when the read is refused", async () => {
    capability.mockReturnValue({
      state: "ready",
      endpoint: "localhost:20000",
      vendor: "Prometheus",
      page: null,
      use: vi.fn(async () => {
        throw new Error("403 Forbidden");
      }),
    });
    wrap(
      <NodeUtilisation
        nodes={[node("a"), node("b")]}
        range="6h"
        onRange={() => {}}
      />
    );
    await screen.findByText(/403 Forbidden/);
    expect(screen.getAllByText("could not look")).toHaveLength(4);
    expect(screen.queryByText(/No node has a CPU/)).toBeNull();
    expect(screen.queryByText("no series")).toBeNull();
  });

  /** A sum of pods is lower than the node's real usage, and the view has to say so. */
  it("says the figures are a sum of pods when that is what they are", async () => {
    capability.mockReturnValue({
      state: "ready",
      endpoint: "localhost:20000",
      vendor: "Prometheus",
      page: null,
      use: vi.fn(async () => ({ ...window, basis: "pods" })),
    });
    wrap(
      <NodeUtilisation nodes={[node("hot")]} range="6h" onRange={() => {}} />
    );
    await screen.findByText("peak 90% · avg 58%");
    expect(screen.getByRole("note")).toHaveTextContent(
      /Summed from each node's pods/
    );
  });

  /** Some nodes answering and some not is per-row, and the block would be a lie about the ones that answered. */
  it("keeps per-row notes when only some nodes are silent", async () => {
    wrap(
      <NodeUtilisation
        nodes={[node("hot"), node("cold")]}
        range="6h"
        onRange={() => {}}
      />
    );
    await screen.findByText("peak 90% · avg 58%");
    const rows = screen.getAllByRole("row");
    expect(rows[2]).toHaveTextContent("cold");
    expect(rows[2]).toHaveTextContent("no series");
    expect(screen.queryByText(/No node has a CPU/)).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
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

describe("what the view offers Share", () => {
  /** Deleting the node's ref from the row breaks this: a shared table of
   *  utilisation would name a node with no way back to it. */
  it("carries a ref, and both lanes, on each table row", async () => {
    let collect: ReturnType<typeof useScreenSections> = null;
    function Probe() {
      collect = useScreenSections();
      return null;
    }
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter>
          <ScreenShareProvider>
            <NodeUtilisation
              nodes={[node("calm"), node("hot")]}
              range="6h"
              onRange={() => {}}
            />
            <Probe />
          </ScreenShareProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await screen.findByText("peak 90% · avg 58%");
    const section = collect!().find((s) => s.id === "utilisation")!;
    const rows = section.body.type === "table" ? section.body.rows : [];
    const hot = rows.find((row) => row.cells[0].text === "hot")!;
    expect(hot.cells[0]).toMatchObject({
      text: "hot",
      ref: { kind: "Node", stem: "hot" },
    });
    expect(hot.cells[1]).toMatchObject({ text: "peak 90% · avg 58%" });
  });

  /** A node list this token could not read must not leave the utilisation
   *  table looking like a cluster with no nodes. */
  it("marks the section unread when the node list did not answer", () => {
    let collect: ReturnType<typeof useScreenSections> = null;
    function Probe() {
      collect = useScreenSections();
      return null;
    }
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter>
          <ScreenShareProvider>
            <NodeUtilisation
              nodes={[]}
              nodesKnown={false}
              nodesReason="Forbidden"
              range="6h"
              onRange={() => {}}
            />
            <Probe />
          </ScreenShareProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );

    const section = collect!().find((s) => s.id === "utilisation");
    expect(section?.unread).toContain("Forbidden");
  });
});
