import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useUsageHistoryStore } from "@/stores/usageHistoryStore";
import { useClusterStore } from "@/stores/clusterStore";
import type {
  ConnectionEdge,
  ObjectRef,
  PrometheusConnection,
  PrometheusProbe,
  PromSeries,
  ResourceConnections,
} from "@/generated/types";

/**
 * The backend, stubbed at the one boundary the vendor folder talks through.
 *
 * Mocking the capability instead would test the block against a fiction: the
 * three states this file pins are produced by the *registry* deciding what a
 * saved address and a probe add up to, and that decision is exactly what
 * must not be able to break silently.
 */
const getPrometheusConnection =
  vi.fn<() => Promise<PrometheusConnection | null>>();
const probePrometheus = vi.fn<() => Promise<PrometheusProbe>>();
const prometheusQueryRange = vi.fn<() => Promise<PromSeries[]>>();
const prometheusQuery = vi.fn<() => Promise<PromSeries[]>>();

vi.mock("@/lib/commands", () => ({
  commands: {
    detectInClusterExtensions: () => Promise.resolve([]),
    getPrometheusConnection: () => getPrometheusConnection(),
    probePrometheus: () => probePrometheus(),
    prometheusQueryRange: () => prometheusQueryRange(),
    prometheusQuery: () => prometheusQuery(),
  },
}));

const { UsageBlock } = await import("@/components/resources/usage-block");

function wrap(node: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = (child: ReactElement) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{child}</MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(ui(node));
  return { ...view, rerender: (next: ReactElement) => view.rerender(ui(next)) };
}

const CONNECTED: PrometheusConnection = {
  url: "http://prometheus.monitoring:9090",
  authType: "none",
  hasToken: false,
  insecureTls: false,
};

const ANSWERED: PrometheusProbe = {
  ok: true,
  at: 1_700_000_000_000,
  latencyMs: 4,
  version: "2.55.1",
};

/** A minute of memory, at the resolution a 15m range would ask for. */
const series = (): PromSeries[] => [
  {
    labels: {},
    points: Array.from({ length: 4 }, (_, i) => ({
      t: 1_700_000_000_000 + i * 15_000,
      v: 40 + i,
    })),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  useUsageHistoryStore.getState().clear();
  useClusterStore.setState({ currentContext: "k3d-k8s-gui-dev" });
  getPrometheusConnection.mockResolvedValue(null);
  probePrometheus.mockResolvedValue(ANSWERED);
  prometheusQueryRange.mockResolvedValue(series());
  prometheusQuery.mockResolvedValue([]);
});

const subject: ObjectRef = {
  kind: "Pod",
  name: "mounts-demo",
  namespace: "k8s-gui-test",
  existence: "present",
  facts: null,
};

const withClaim = (): ResourceConnections => {
  const edge: ConnectionEdge = {
    from: subject,
    to: {
      kind: "PersistentVolumeClaim",
      name: "pvc-demo",
      namespace: "k8s-gui-test",
      existence: "present",
      facts: {
        kind: "claim",
        phase: "Bound",
        capacity: "1Gi",
        storageClass: "local-path",
      },
    },
    relation: {
      verb: "uses",
      usages: [
        {
          how: "mount",
          container: "app",
          path: "/var/lib/data",
          readOnly: false,
          subPath: null,
          volume: "data",
          projected: false,
        },
      ],
    },
  };
  return { subject, edges: [edge], stops: [], published: [], notLookedAt: [] };
};

// The detection scan is gated on a standing connection now — these tests
// exercise what detection hands out, so the gate is opened for them.
beforeEach(() => {
  useClusterStore.setState({ isConnected: true, currentContext: "test" });
});

describe("UsageBlock when metrics-server is missing", () => {
  beforeEach(() => useUsageHistoryStore.getState().clear());

  it("degrades to saying so rather than to an empty plot", () => {
    wrap(
      <UsageBlock
        kind="Pod"
        uid="uid-1"
        cpu={null}
        memory={null}
        cpuLimit={200}
        memoryLimit={null}
        sampledAt={null}
        status={{ status: "notInstalled", message: null }}
      />
    );
    expect(screen.getAllByText("no metrics-server")).toHaveLength(2);
    expect(document.querySelector("svg")).toBeNull();
  });

  it("offers no range picker when there is nothing to range over", () => {
    wrap(
      <UsageBlock
        kind="Pod"
        uid="uid-1"
        cpu={null}
        memory={null}
        cpuLimit={200}
        memoryLimit={null}
        sampledAt={null}
        status={{ status: "notInstalled", message: null }}
      />
    );
    expect(
      screen.queryByRole("button", { name: "1h" })
    ).not.toBeInTheDocument();
  });
});

describe("UsageBlock range picker", () => {
  beforeEach(() => useUsageHistoryStore.getState().clear());

  it("draws the longer ranges as unavailable rather than pretending they work", () => {
    wrap(
      <UsageBlock
        kind="Pod"
        uid="uid-2"
        cpu={48}
        memory={null}
        cpuLimit={200}
        memoryLimit={null}
        sampledAt={1_700_000_000_000}
        status={{ status: "available", message: null }}
      />
    );
    for (const range of ["1h", "6h", "24h"]) {
      expect(screen.getByRole("button", { name: range })).toBeDisabled();
    }
  });

  it("names what the ranges are waiting on", () => {
    wrap(
      <UsageBlock
        kind="Pod"
        uid="uid-2b"
        cpu={48}
        memory={null}
        cpuLimit={200}
        memoryLimit={null}
        sampledAt={1_700_000_000_000}
        status={{ status: "available", message: null }}
      />
    );
    expect(
      screen.getByRole("button", { name: "1h" }).getAttribute("title")
    ).toMatch(/Prometheus/);
  });
});

describe("UsageBlock storage summary", () => {
  beforeEach(() => useUsageHistoryStore.getState().clear());

  const renderWithStorage = () =>
    wrap(
      <UsageBlock
        kind="Pod"
        uid="uid-3"
        cpu={48}
        memory={null}
        cpuLimit={200}
        memoryLimit={null}
        sampledAt={1_700_000_000_000}
        status={{ status: "available", message: null }}
        connections={withClaim()}
      />
    );

  it("gives the declared size of what the workload mounts", () => {
    renderWithStorage();
    expect(screen.getByText(/pvc-demo/)).toBeInTheDocument();
    expect(screen.getByText("1Gi")).toBeInTheDocument();
  });

  it("says the number is size and not fullness", () => {
    renderWithStorage();
    expect(
      screen.getByText(/Declared size, not how full/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/a Prometheus can read and this app cannot/i)
    ).toBeInTheDocument();
  });

  it("draws no used-vs-total bar for a volume, because nothing measured one", () => {
    const { container } = renderWithStorage();
    const storage = screen.getByText(
      /Declared size, not how full/i
    ).parentElement!;
    expect(storage.querySelectorAll('[style*="width"]')).toHaveLength(0);
    // And no percentage anywhere near the volume line.
    expect(container.textContent).not.toMatch(/1Gi[^.]*\d+\s*%/);
  });
});

describe("UsageBlock window label", () => {
  beforeEach(() => useUsageHistoryStore.getState().clear());

  it("says the history is only what this page has watched", () => {
    wrap(
      <UsageBlock
        kind="Pod"
        uid="uid-4"
        cpu={48}
        memory={96}
        cpuLimit={200}
        memoryLimit={128}
        sampledAt={Date.now()}
        status={{ status: "available", message: null }}
      />
    );
    expect(
      screen.getByText(/watched since you opened this page/i)
    ).toBeInTheDocument();
  });
});

describe("UsageBlock with no limits at all", () => {
  beforeEach(() => useUsageHistoryStore.getState().clear());

  /** Two polls, so the bands are past "watching from now" and drawing. */
  const renderPolled = (props: {
    uid: string;
    cpuLimit: number | null;
    memoryLimit: number | null;
  }) => {
    const base = {
      kind: "Pod" as const,
      cpu: 12,
      memory: 4096,
      status: { status: "available" as const, message: null },
    };
    const view = wrap(
      <UsageBlock {...base} {...props} sampledAt={1_700_000_000_000} />
    );
    view.rerender(
      <UsageBlock {...base} {...props} sampledAt={1_700_000_002_000} />
    );
    return view;
  };

  it("says there is no ceiling once, not once per measure", () => {
    renderPolled({ uid: "uid-5", cpuLimit: null, memoryLimit: null });
    expect(screen.getAllByText(/No limit set/i)).toHaveLength(1);
  });

  it("shows neither a denominator nor a percentage for either measure", () => {
    // The live bug: a caption promising "against this pod's limits" over a
    // full-width empty track, on a pod that declares none.
    const { container } = renderPolled({
      uid: "uid-6",
      cpuLimit: null,
      memoryLimit: null,
    });
    expect(container.textContent).not.toMatch(/\d\s*%/);
    // Nothing on either row is sized as a fraction of a ceiling. The chart's
    // own surface fills its band by construction and is not one.
    const shares = [
      ...container.querySelectorAll<HTMLElement>('[style*="width"]'),
    ].filter((element) => !element.closest(".recharts-wrapper"));
    expect(shares).toHaveLength(0);
  });

  it("still attaches the sentence to the one measure that lacks a ceiling", () => {
    const { container } = renderPolled({
      uid: "uid-7",
      cpuLimit: null,
      memoryLimit: 128 * 1024 * 1024,
    });
    expect(screen.getAllByText(/No limit set/i)).toHaveLength(1);
    // The measure that does have one still reads against it.
    expect(container.textContent).toMatch(/\/128Mi/);
  });
});

describe("UsageBlock degraded, on a workload that declares no limits", () => {
  beforeEach(() => useUsageHistoryStore.getState().clear());

  const renderDegraded = () =>
    wrap(
      <UsageBlock
        kind="Pod"
        uid="uid-8"
        cpu={null}
        memory={null}
        cpuLimit={null}
        memoryLimit={null}
        sampledAt={null}
        status={{ status: "error", message: "503" }}
      />
    );

  it("draws no track, because there is neither a reading nor a denominator", () => {
    // The screenshotted bug, in the one path that still fell back to bars:
    // a full-width empty track under a caption promising a comparison
    // against limits the workload does not declare.
    const { container } = renderDegraded();
    expect(container.querySelectorAll('[style*="width"]')).toHaveLength(0);
    expect(container.textContent).not.toMatch(/\d\s*%/);
  });

  it("does not claim to be measuring against limits that do not exist", () => {
    renderDegraded();
    expect(
      screen.queryByText(/against declared limits/i)
    ).not.toBeInTheDocument();
    expect(screen.getByText(/no limits declared/i)).toBeInTheDocument();
  });
});

describe("UsageBlock in its first seconds", () => {
  beforeEach(() => useUsageHistoryStore.getState().clear());

  it("says the window starts now, once for the pair rather than once per band", () => {
    wrap(
      <UsageBlock
        kind="Pod"
        uid="uid-9"
        cpu={48}
        memory={96}
        cpuLimit={200}
        memoryLimit={128}
        sampledAt={1_700_000_000_000}
        status={{ status: "available", message: null }}
      />
    );
    expect(screen.getAllByText(/Watching from now/i)).toHaveLength(1);
  });
});

/**
 * The three states section 4 of the integrations mock owes, each pinned.
 *
 * The middle one is the trap and the reason this describe block exists: an
 * integration that falls back silently is indistinguishable from one nobody
 * configured, and the reader concludes the app is broken rather than their
 * Prometheus.
 */
describe("UsageBlock and a history supplier", () => {
  const live = {
    kind: "Pod" as const,
    cpu: 48,
    memory: 96,
    cpuLimit: 200,
    memoryLimit: 128,
    sampledAt: 1_700_000_000_000,
    status: { status: "available" as const, message: null },
    history: {
      kind: "pod" as const,
      namespace: "k8s-gui-test",
      pod: "busy-demo-cb8d8b486-4r2jl",
    },
  };

  /**
   * Would break if the offer disappeared, or grew into an advert. One quiet
   * line, once, under a chart that is whole without it.
   */
  it("not configured: the core chart, dimmed ranges, and one quiet offer", async () => {
    wrap(<UsageBlock {...live} uid="uid-10" />);

    expect(
      await screen.findByText(/Longer than this needs a Prometheus/i)
    ).toBeInTheDocument();
    for (const range of ["15m", "1h", "6h", "24h"]) {
      expect(screen.getByRole("button", { name: range })).toBeDisabled();
    }
    // The core answer is drawn and stays drawn.
    expect(
      screen.getAllByText(
        /watched since you opened this page|watching from now/i
      ).length
    ).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "connect one" })).toHaveAttribute(
      "href",
      "/integrations"
    );
  });

  /**
   * Would break if the ranges stopped coming alive, or if the chart stopped
   * saying where its numbers came from. A chart whose provenance is unstated
   * is a chart nobody can check.
   */
  it("working: the ranges are live and the label names the endpoint", async () => {
    getPrometheusConnection.mockResolvedValue(CONNECTED);

    wrap(<UsageBlock {...live} uid="uid-11" />);

    const hour = await screen.findByRole("button", { name: "1h" });
    await waitFor(() => expect(hour).toBeEnabled());
    // The offer is gone, because there is nothing left to offer.
    expect(
      screen.queryByText(/Longer than this needs a Prometheus/i)
    ).toBeNull();

    await userEvent.click(hour);

    expect(
      await screen.findByText(/from prometheus\.monitoring:9090/)
    ).toBeInTheDocument();
    // And the resolution, because a bucket that hides a spike must say how
    // wide it is and whether it holds the peak.
    expect(
      screen.getByText(/30s buckets, max over a 15s resolution/)
    ).toBeInTheDocument();
  });

  /**
   * **The one that must fail if the fallback stops stating the loss.**
   *
   * Both halves are the assertion: the core chart is still there, *and* the
   * reader is told which of the two possible worlds they are in. Dropping
   * either one is the bug.
   */
  it("unreachable: the watched window comes back and the loss is stated", async () => {
    getPrometheusConnection.mockResolvedValue(CONNECTED);
    probePrometheus.mockResolvedValue({
      ok: false,
      at: 1_700_000_000_000,
      latencyMs: 12,
      reason: "no route to host",
    });

    wrap(<UsageBlock {...live} uid="uid-12" />);

    const said = await screen.findByText(/did not answer/i);
    expect(said.textContent).toMatch(/Prometheus did not answer/);
    expect(said.textContent).toMatch(/no route to host/);
    expect(said.textContent).toMatch(
      /This is the window the app watched itself; the longer ranges are gone until it is back/
    );

    // An integration may never take something away.
    expect(
      screen.getAllByText(
        /watched since you opened this page|watching from now/i
      ).length
    ).toBeGreaterThan(0);
    // And it must not read as never-configured.
    expect(
      screen.queryByText(/Longer than this needs a Prometheus/i)
    ).toBeNull();
  });

  /**
   * Would break if the page started waiting on somebody else's server before
   * drawing numbers it already had — which would make the page worse with
   * the integration than without one.
   */
  it("never blocks the live window on the range query", async () => {
    getPrometheusConnection.mockResolvedValue(CONNECTED);
    prometheusQueryRange.mockReturnValue(new Promise(() => {}));

    wrap(<UsageBlock {...live} uid="uid-13" />);

    const hour = await screen.findByRole("button", { name: "1h" });
    await waitFor(() => expect(hour).toBeEnabled());
    await userEvent.click(hour);

    // Still the watched window, drawn, while the range is in flight.
    expect(
      screen.getAllByText(
        /watched since you opened this page|watching from now/i
      ).length
    ).toBeGreaterThan(0);
  });
});

describe("UsageBlock storage fullness", () => {
  const withFullness = (used: number, capacity: number): PromSeries[][] => [
    [
      {
        labels: { persistentvolumeclaim: "pvc-demo" },
        points: [{ t: 1, v: used }],
      },
    ],
    [
      {
        labels: { persistentvolumeclaim: "pvc-demo" },
        points: [{ t: 1, v: capacity }],
      },
    ],
  ];

  /**
   * Would break if the fallback sentence survived a volume that was actually
   * measured, or if fullness arrived as a bare percentage — the kubelet
   * reports the filesystem behind the volume, which for a quota-less
   * provisioner is the node's disk and not the declared 1Gi.
   */
  it("states used and capacity, and drops the sentence it replaced", async () => {
    getPrometheusConnection.mockResolvedValue(CONNECTED);
    const answers = withFullness(512 * 1024 * 1024, 1024 * 1024 * 1024);
    prometheusQuery
      .mockResolvedValueOnce(answers[0])
      .mockResolvedValueOnce(answers[1]);

    wrap(
      <UsageBlock
        kind="Pod"
        uid="uid-14"
        cpu={48}
        memory={96}
        cpuLimit={200}
        memoryLimit={128}
        sampledAt={1_700_000_000_000}
        status={{ status: "available", message: null }}
        connections={withClaim()}
      />
    );

    expect(
      await screen.findByText(/512Mi used of 1Gi · 50%/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/Declared size, not how full/i)).toBeNull();
  });

  /**
   * Would break if a volume the kubelet does not report on started drawing
   * an empty bar. "No kubelet scraping" and "an unprovisioned volume" look
   * identical from here, and an empty bar reads as 0% full for both.
   */
  it("keeps the fallback sentence for a volume nothing measured", async () => {
    getPrometheusConnection.mockResolvedValue(CONNECTED);
    prometheusQuery.mockResolvedValue([]);

    wrap(
      <UsageBlock
        kind="Pod"
        uid="uid-15"
        cpu={48}
        memory={96}
        cpuLimit={200}
        memoryLimit={128}
        sampledAt={1_700_000_000_000}
        status={{ status: "available", message: null }}
        connections={withClaim()}
      />
    );

    expect(
      await screen.findByText(/Declared size, not how full/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/used of/)).toBeNull();
  });
});
