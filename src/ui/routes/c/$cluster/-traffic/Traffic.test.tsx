import { screen } from "@testing-library/react";
import { useEffect } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import type { FlowEnd, Measure } from "@/generated/types";
import type { TrafficState } from "@/hooks/useTraffic";
import {
  MEASURES,
  pairRows,
  type FlowSource,
  type TrafficReading,
} from "@/lib/traffic";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";

const traffic = vi.fn<() => TrafficState>();
const stream = vi.hoisted(() => ({ opened: 0, closed: 0 }));

vi.mock("@/hooks/useTraffic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useTraffic")>()),
  useTraffic: () => traffic(),
}));
vi.mock("../-map/useTopology", () => ({
  useTopology: () => {
    useEffect(() => {
      stream.opened += 1;
      return () => {
        stream.closed += 1;
      };
    }, []);
    return {
      phase: "ready",
      nodes: new Map(),
      edges: new Map(),
      reads: new Map(),
      kinds: [],
      end: null,
      error: null,
      version: 1,
    };
  },
}));
vi.mock("../-map/GraphCanvas", () => ({
  GraphCanvas: ({ edges }: { edges: { id: string; sub?: string }[] }) => (
    <ul data-testid="canvas">
      {edges.map((edge) => (
        <li key={edge.id}>{edge.sub}</li>
      ))}
    </ul>
  ),
}));

const { Traffic } = await import("./Traffic");

const ISTIO: FlowSource = {
  id: "istio",
  name: "Istio",
  state: { says: "present" },
  measures: ["requests", "errors", "p50", "p95", "p99"],
  found: ["istio_requests_total"],
  need: "needIstio",
  marks: true,
  nodeAgent: false,
};
const HUBBLE: FlowSource = {
  ...ISTIO,
  id: "hubble",
  name: "Hubble",
  state: { says: "absent" },
  need: "needHubble",
  marks: false,
  nodeAgent: true,
};

const workload = (name: string): FlowEnd => ({
  is: "workload",
  key: { namespace: "shop", group: "apps", kind: "Deployment", name },
});

function read(set: Partial<Record<Measure, number>> | null): TrafficState {
  const reading: TrafficReading = {
    sources: [ISTIO],
    window: "5m",
    answer: {
      ends: [workload("cart"), workload("pay")],
      flows: set
        ? [
            {
              source: 0,
              from: 0,
              to: 1,
              protocols: ["http"],
              values: MEASURES.map((measure) => set[measure] ?? null),
              reasons: [],
            },
          ]
        : [],
      reads: [],
      observed: null,
      coverage: [],
      podsUnread: [],
      podsFailed: null,
      cut: 0,
    },
  };
  return {
    says: "read",
    endpoint: "prom.example.com",
    sources: [ISTIO, HUBBLE],
    reading,
    rows: pairRows(reading).rows,
    lastFailed: null,
  };
}

const open = () =>
  renderWithRouter(<Traffic />, {
    at: "/c/prod/traffic",
    route: "/c/$cluster/traffic",
  });

beforeEach(() => {
  stream.opened = 0;
  stream.closed = 0;
  useClusterStore.setState({
    currentContext: "prod",
    isConnected: true,
    namespaceScope: [],
  });
});
afterEach(() => {
  useClusterStore.setState({ currentContext: null, isConnected: false });
});

describe("the Traffic page", () => {
  /**
   * With nothing to read from, the page names the four sources and what
   * each needs, and stops: no map stream is opened for a page with no flows.
   */
  it("names the sources and opens no map when no supplier is connected", async () => {
    traffic.mockReturnValue({ says: "absent" });
    await open();
    expect(screen.getByTestId("traffic-stopped").textContent).toContain(
      "Rubick installs none of them"
    );
    expect(screen.getByText(/^Hubble: hubble\.metrics\.enabled/)).toBeTruthy();
    expect(stream.opened).toBe(0);
  });

  /**
   * Not connected, connected without sources, and a read that failed are
   * three sentences, and none of them is "no flows".
   */
  it("says unreachable, no source and failed apart, never as no flows", async () => {
    const said = async (state: TrafficState) => {
      traffic.mockReturnValue(state);
      const page = await open();
      const text = screen.getByTestId("traffic-stopped").textContent ?? "";
      page.unmount();
      return text;
    };
    const unreachable = await said({
      says: "unreachable",
      vendor: "Prometheus",
      endpoint: "prom.example.com",
      reason: "connection refused",
    });
    const none = await said({
      says: "noSource",
      endpoint: "prom.example.com",
      sources: [HUBBLE],
    });
    const failed = await said({
      says: "failed",
      endpoint: "prom.example.com",
      sources: [ISTIO],
      said: "timed out after 20s",
    });
    expect(unreachable).toContain("did not answer: connection refused");
    expect(none).toContain(
      "holds no series from Istio, Hubble, Beyla or Caretta"
    );
    expect(none).toContain("hubble.metrics.enabled");
    expect(failed).toContain(
      "could not be read from prom.example.com: timed out after 20s"
    );
    for (const text of [unreachable, none, failed])
      expect(text).not.toMatch(/saw no flows/);
    expect(stream.opened).toBe(0);
  });

  /** A reading draws the flows, holds the map's stream while on screen, and lets it go when left. */
  it("draws a reading's flows and lets the map's stream go when it is left", async () => {
    traffic.mockReturnValue(read({ requests: 12, errors: 0, p95: 7 }));
    const page = await open();
    expect(screen.getByTestId("canvas").textContent).toContain("12 req/s");
    expect(screen.getByTestId("canvas").textContent).toContain("Istio");
    expect(stream.opened).toBe(1);
    page.unmount();
    expect(stream.closed).toBe(1);
  });

  /** A source that answered with nothing in the window says so, by name and window. */
  it("says which source saw no flows in the window", async () => {
    traffic.mockReturnValue(read(null));
    await open();
    expect(
      screen.getAllByText(
        /Istio saw no flows in any namespace in the last 5 minutes/
      ).length
    ).toBeGreaterThan(0);
  });
});
