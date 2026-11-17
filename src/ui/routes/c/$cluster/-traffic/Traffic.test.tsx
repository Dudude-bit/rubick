import { fireEvent, screen } from "@testing-library/react";
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
import type { LiveSnapshot } from "@/hooks/useLiveTraffic";
import type { TrafficState } from "@/hooks/useTraffic";
import {
  MEASURES,
  pairRows,
  type FlowSource,
  type TrafficReading,
} from "@/lib/traffic";
import { useClusterStore } from "@/stores/clusterStore";
import { vendorLink } from "@/lib/links";
import { renderWithRouter } from "@/test/render";

const traffic = vi.fn<() => TrafficState>();
const live = vi.fn<() => LiveSnapshot | null>(() => null);
const liveCapability = vi.fn<() => unknown>(() => null);
const stream = vi.hoisted(() => ({ opened: 0, closed: 0 }));

vi.mock("@/hooks/useTraffic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useTraffic")>()),
  useTraffic: () => traffic(),
}));
vi.mock("@/hooks/useLiveTraffic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useLiveTraffic")>()),
  useLiveTraffic: () => live(),
}));
vi.mock("@/integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/integrations")>()),
  useCapability: (key: string) =>
    key === "traffic.live" ? liveCapability() : null,
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
  needsPods: false,
  grpcErrors: true,
};
const HUBBLE: FlowSource = {
  ...ISTIO,
  id: "hubble",
  name: "Hubble",
  state: { says: "absent" },
  need: "needHubble",
  marks: false,
  nodeAgent: true,
  grpcErrors: false,
};

const workload = (name: string): FlowEnd => ({
  is: "workload",
  key: { namespace: "shop", group: "apps", kind: "Deployment", name },
});

function read(
  set: Partial<Record<Measure, number>> | null,
  reads: TrafficReading["answer"]["reads"] = []
): TrafficState {
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
              sides: [],
              values: MEASURES.map((measure) => set[measure] ?? null),
              reasons: [],
            },
          ]
        : [],
      reads,
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

/** A supplier that did not answer its probe, as the capability hands it over. */
const down = (askAgain: () => void) => ({
  state: "unreachable" as const,
  vendor: "Prometheus",
  endpoint: "prom.example.com",
  reason: "connection refused",
  askAgain,
  asking: false,
  settings: vendorLink("prometheus", { tab: "connection" }),
});

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
      power: down(() => {}),
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

  /**
   * A probe's answer is cached and never retried behind the reader's back:
   * where the page says the supplier did not answer, it offers to ask again
   * and its Connection tab, or it says so after the supplier is back.
   */
  it("offers to ask a supplier that did not answer again, and its connection", async () => {
    const askAgain = vi.fn();
    traffic.mockReturnValue({ says: "unreachable", power: down(askAgain) });
    await open();
    fireEvent.click(screen.getByTestId("ask-supplier-again"));
    expect(askAgain).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("link", { name: "Prometheus connection" })
    ).toBeTruthy();
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

  /**
   * Bytes/s and Drops/s stood empty and as wide as the rest where no source
   * measures them; a source that could not be looked for might, so then
   * they stay.
   */
  it("draws no column no found source measures, and names those it left out", async () => {
    traffic.mockReturnValue(read({ requests: 12 }));
    const page = await open();
    const headers = screen
      .getAllByRole("columnheader")
      .map((header) => header.textContent);
    expect(headers.join(" ")).not.toContain("Bytes/s");
    expect(screen.getByTestId("columns-note").textContent).toBe(
      "Not drawn, no source here measures them: Flows/s, Bytes/s, Drops/s"
    );
    page.unmount();
    const state = read({ requests: 12 });
    if (state.says !== "read") throw new Error("a reading");
    traffic.mockReturnValue({
      ...state,
      sources: [
        ...state.sources,
        { ...HUBBLE, state: { says: "failed", said: "timed out" } },
      ],
    });
    await open();
    expect(screen.queryByTestId("columns-note")).toBeNull();
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

  /**
   * Every flow query refused by Prometheus is an answer of nothing, and the
   * sentence over the map must say it could not be read, not that it was quiet.
   */
  it("says a source whose flow queries failed could not be read, never that it saw no flows", async () => {
    const refused = {
      says: "failed" as const,
      code: "PROMETHEUS",
      message: "query processing would load too many samples into memory",
    };
    traffic.mockReturnValue(
      read(null, [
        { source: 0, measure: "requests", state: refused },
        { source: 0, measure: "errors", state: refused },
      ])
    );
    await open();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/saw no flows/);
    expect(text).toContain(
      "Istio: flows could not be read, so whether there were any is not known."
    );
    expect(text).toContain(
      "Istio's flows could not be read: query processing would load too many samples into memory"
    );
  });
});

describe("the Traffic page, live", () => {
  const snapshot = (over: Partial<LiveSnapshot>): LiveSnapshot => ({
    phase: "live",
    pairs: new Map(),
    relay: {
      namespace: "kube-system",
      service: "hubble-relay",
      pod: "relay-1",
      tls: false,
    },
    lost: 0,
    untracked: 0,
    unreached: [],
    end: null,
    error: null,
    ...over,
  });

  beforeEach(() => liveCapability.mockReturnValue({ open: () => () => {} }));
  afterEach(() => {
    liveCapability.mockReturnValue(null);
    live.mockReturnValue(null);
  });

  /**
   * With nothing windowed to read and Hubble Relay to read from, the page
   * reads it live instead of stopping at the list of sources.
   */
  it("reads live where no windowed source is there", async () => {
    traffic.mockReturnValue({ says: "absent" });
    live.mockReturnValue(
      snapshot({
        pairs: new Map([
          [
            "a",
            {
              from: workload("cart"),
              to: workload("pay"),
              forwarded: 4,
              dropped: 0,
              drops: [],
              requests: null,
              errors: null,
              p50: null,
              p95: null,
              p99: null,
              protocols: [],
            },
          ],
        ]),
      })
    );
    await open();
    expect(screen.getByTestId("canvas").textContent).toContain(
      "4 flow events/s · Hubble Relay"
    );
    expect(
      screen.getByText(/Live from Hubble Relay kube-system\/hubble-relay/)
    ).toBeTruthy();
    expect(screen.queryByText(/Rubick installs none of them/)).toBeNull();
  });

  /**
   * Not enabled, not looked for and serving TLS are three sentences, and
   * none of them is "no flows".
   */
  it("says not enabled, could not look, mutual TLS, an unread CA and an unverified certificate apart, never as no flows", async () => {
    traffic.mockReturnValue({ says: "absent" });
    const said = async (end: LiveSnapshot["end"]) => {
      live.mockReturnValue(snapshot({ phase: "ended", end, relay: null }));
      const page = await open();
      const text = screen.getByTestId("traffic-stopped").textContent ?? "";
      page.unmount();
      return text;
    };
    const off = await said({ says: "notEnabled" });
    const unread = await said({
      says: "notLooked",
      said: "services is forbidden",
    });
    const tls = await said({ says: "mutualTls", namespace: "kube-system" });
    const ca = await said({
      says: "caUnread",
      namespace: "kube-system",
      said: "secrets is forbidden",
    });
    const unverified = await said({
      says: "notVerified",
      namespace: "kube-system",
      said: "invalid peer certificate: UnknownIssuer",
    });
    expect(off).toContain("Hubble Relay is not enabled");
    expect(unread).toContain(
      "Could not look for Hubble Relay: services is forbidden"
    );
    expect(tls).toContain("mutual TLS");
    expect(ca).toContain("could not be read: secrets is forbidden");
    expect(unverified).toContain(
      "does not vouch for: invalid peer certificate: UnknownIssuer"
    );
    for (const text of [off, unread, tls, ca, unverified])
      expect(text).not.toMatch(/saw no flows/);
  });

  /**
   * A node the relay cannot reach sends no flows: an empty map then is not
   * a quiet cluster, and the page names the nodes and why.
   */
  it("names the nodes the relay cannot reach and never calls their silence no flows", async () => {
    traffic.mockReturnValue({ says: "absent" });
    live.mockReturnValue(
      snapshot({
        unreached: [
          {
            name: "kind/worker",
            state: "NODE_UNAVAILABLE",
            message: "connection refused",
          },
        ],
      })
    );
    await open();
    const text = document.body.textContent ?? "";
    expect(text).toContain(
      "Hubble Relay cannot reach kind/worker (connection refused)"
    );
    expect(text).toContain("on the nodes it reaches");
    expect(text).not.toContain("saw no flows in any namespace in the");
  });

  /** Without anything live to read, there is no live switch to offer. */
  it("offers the live switch only where something reads live", async () => {
    traffic.mockReturnValue(read({ requests: 1 }));
    const page = await open();
    expect(screen.getByRole("button", { name: "Live" })).toBeTruthy();
    page.unmount();
    liveCapability.mockReturnValue(null);
    await open();
    expect(screen.queryByRole("button", { name: "Live" })).toBeNull();
  });
});
