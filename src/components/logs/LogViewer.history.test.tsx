import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ----- Mocks -----

const listeners: Record<
  string,
  ((event: { payload: unknown }) => void) | undefined
> = {};

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (event: string, handler: (e: { payload: unknown }) => void) => {
      listeners[event] = handler;
      return () => {
        delete listeners[event];
      };
    }
  ),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    streamPodLogs: vi.fn(async () => "stream-id-1"),
    stopLogStream: vi.fn(async () => undefined),
    logStreamSubscribed: vi.fn(async () => undefined),
    getPodLogs: vi.fn(async () => []),
    detectInClusterExtensions: vi.fn(async () => []),
    getPrometheusConnection: vi.fn(async () => null),
    getLokiConnection: vi.fn(async () => null),
    probeLoki: vi.fn(),
    lokiQueryRange: vi.fn(),
  },
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import { TooltipProvider } from "@/components/ui/tooltip";
import { commands } from "@/lib/commands";
import type { ContainerInfo, LokiPage } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { LogViewer } from "./LogViewer";

const asMock = <T extends (...args: never[]) => unknown>(fn: T) =>
  fn as unknown as ReturnType<typeof vi.fn>;

function Providers({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>{children}</TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const app: ContainerInfo = {
  name: "app",
  image: "busybox:1.36",
  ready: true,
  started: true,
  phase: "app",
  state: { type: "running" },
  lastTerminated: null,
  restartCount: 0,
  ports: [],
  env: [],
  envFrom: [],
};

const props = {
  podName: "log-demo-7f9",
  namespace: "default",
  containers: [app],
};

/** A page as the backend hands it over. */
function page(lines: number, overrides: Partial<LokiPage> = {}): LokiPage {
  return {
    lines: Array.from({ length: lines }, (_, index) => ({
      ts: `${1_700_000_000_000_000_000 + index}`,
      line: {
        timestamp: new Date(1_700_000_000_000 + index).toISOString(),
        message: `kept line ${index}`,
        level: null,
        format: "plain",
        fields: null,
        raw: `kept line ${index}`,
        pod: "log-demo-old",
        container: "app",
        namespace: "default",
      },
    })),
    streams: lines > 0 ? 1 : 0,
    truncated: false,
    limit: 1000,
    ...overrides,
  } as LokiPage;
}

/** A stream that is up, then a live line, then the pod going away. */
async function renderStranded() {
  render(
    <Providers>
      <LogViewer {...props} />
    </Providers>
  );
  // Not just the listener: the batch handler drops anything whose stream id
  // it has not been told about yet, and that mapping is written after
  // `streamPodLogs` resolves.
  await waitFor(() =>
    expect(asMock(commands.logStreamSubscribed)).toHaveBeenCalled()
  );

  act(() => {
    listeners["log-batch"]!({
      payload: {
        stream_id: "stream-id-1",
        lines: [
          {
            message: "the live line",
            timestamp: new Date().toISOString(),
            level: null,
            format: "plain",
            fields: null,
            raw: "the live line",
          },
        ],
      },
    });
  });
  act(() => {
    listeners["stream-failed"]!({
      payload: {
        stream_id: "stream-id-1",
        kind: "gone",
        message: "container app is no longer running",
      },
    });
  });
  await screen.findByTestId("log-stream-failure");
  await waitFor(() => expect(held()).toBe(1));
}

/**
 * How many lines the pane is holding.
 *
 * The list is virtualised and renders nothing into a jsdom viewport with no
 * height, so the buffer meter is what these tests read — and it is the right
 * question anyway: whether the live lines are still *held* beside the history,
 * not which of them a scroll position reveals.
 */
function held(): number {
  return Number(
    screen
      .getByRole("meter", { name: "Buffer fill" })
      .getAttribute("aria-valuenow")
  );
}

/**
 * A store configured for *this cluster*. An address is stored against a
 * kubeconfig context, so without one there is nothing to have configured —
 * which is why the context is set here rather than left at its default.
 */
function connected() {
  useClusterStore.setState({ currentContext: "k3d-test" });
  asMock(commands.getLokiConnection).mockResolvedValue({
    url: "http://loki.monitoring:3100",
    authType: "none",
    hasToken: false,
    insecureTls: false,
  });
}

/**
 * The three states a configured integration owes the surface it extends, on
 * the one surface where getting them wrong is worst: a log pane that quietly
 * showed less log is a reader concluding their container printed nothing
 * before it died. So each of the three is pinned, and every one of them
 * checks that **the live line is still on screen** — the core answer draws
 * first and stays drawn, whatever the integration is doing.
 */
// The detection scan is gated on a standing connection now — these tests
// exercise what detection hands out, so the gate is opened for them.
beforeEach(() => {
  useClusterStore.setState({ isConnected: true, currentContext: "test" });
});

describe("a pod whose log the API server can no longer serve", () => {
  beforeEach(() => {
    for (const key of Object.keys(listeners)) delete listeners[key];
    vi.clearAllMocks();
    useClusterStore.setState({ currentContext: "k3d-test" });
    asMock(commands.getLokiConnection).mockResolvedValue(null);
  });

  it("makes one quiet offer where no store is configured", async () => {
    await renderStranded();

    const bar = await screen.findByTestId("log-history-absent");
    expect(bar).toHaveTextContent(/needs a Loki/);
    expect(screen.getByRole("link", { name: /connect one/i })).toBeVisible();
    // The offer never replaces the log it is offered beside.
    expect(held(), "the live line was dropped").toBe(1);
  });

  it("states the loss when the store is configured and not answering", async () => {
    connected();
    asMock(commands.probeLoki).mockResolvedValue({
      ok: false,
      at: Date.now(),
      latencyMs: 3,
      reason: "no route to host",
      labels: [],
    });

    await renderStranded();

    const bar = await screen.findByTestId("log-history-unreachable");
    expect(bar).toHaveTextContent(/Loki did not answer — no route to host/);
    expect(bar).toHaveTextContent(/live stream above is untouched/);
    expect(held(), "a store that is down cost the pane its live lines").toBe(1);
    expect(
      asMock(commands.lokiQueryRange),
      "a store that is not answering was queried anyway"
    ).not.toHaveBeenCalled();
  });

  it("offers the store's lines, and fetches none of them until asked", async () => {
    connected();
    asMock(commands.probeLoki).mockResolvedValue({
      ok: true,
      at: Date.now(),
      latencyMs: 4,
      version: "3.1.1",
      retention: "3d",
      labels: ["namespace", "pod", "container"],
    });
    asMock(commands.lokiQueryRange).mockResolvedValue(page(2));

    await renderStranded();

    const offer = await screen.findByTestId("log-history-offer");
    expect(offer).toHaveTextContent(/Loki may still have those lines/);
    expect(
      asMock(commands.lokiQueryRange),
      "somebody else's server was asked before the reader asked"
    ).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByRole("button", { name: /Read what Loki kept/ })
    );

    const loaded = await screen.findByTestId("log-history-loaded");
    expect(loaded).toHaveTextContent(/History/);
    expect(loaded).toHaveTextContent(/from loki\.monitoring:3100/);
    expect(loaded).toHaveTextContent(/Not live/);
    // Two kept lines in front of the one live line, in one buffer — which is
    // the whole point: the reader scrolls up out of the crash into the run
    // that caused it without changing panes.
    await waitFor(() => expect(held()).toBe(3));
  });

  /**
   * The one this file exists for. A log pane has no axis and no total, so
   * "the newest thousand lines of six hours" and "everything this workload
   * wrote in six hours" look identical on screen — and a reader who takes a
   * page that stopped at a limit for the whole range concludes the gap they
   * are looking for is not there.
   */
  it("says a page that filled the limit is only the newest of the range", async () => {
    connected();
    asMock(commands.probeLoki).mockResolvedValue({
      ok: true,
      at: Date.now(),
      latencyMs: 4,
      version: "3.1.1",
      labels: [],
    });
    asMock(commands.lokiQueryRange).mockResolvedValue(
      page(3, { truncated: true, limit: 3 })
    );

    await renderStranded();
    await userEvent.click(
      await screen.findByRole("button", { name: /Read what Loki kept/ })
    );

    const notice = await screen.findByTestId("log-history-truncated");
    expect(notice).toHaveTextContent(
      /Showing the newest 3 lines of this range/
    );
    expect(notice).toHaveTextContent(/there is more inside it/);
    // A partial answer is exactly when walking backwards is worth offering.
    expect(screen.getByRole("button", { name: "Load older" })).toBeVisible();
  });

  /**
   * Zero streams is not zero lines, and the difference is the reader's to
   * fix. Promtail's and Alloy's stock configs write `namespace` and `pod`;
   * an install that relabels them answers every query here with nothing, and
   * an empty pane would read as "this pod never logged".
   */
  it("says which labels it tried when nothing matched at all", async () => {
    connected();
    asMock(commands.probeLoki).mockResolvedValue({
      ok: true,
      at: Date.now(),
      latencyMs: 4,
      version: "3.1.1",
      labels: ["k8s_namespace_name", "k8s_pod_name"],
    });
    asMock(commands.lokiQueryRange).mockResolvedValue(page(0, { streams: 0 }));

    await renderStranded();
    await userEvent.click(
      await screen.findByRole("button", { name: /Read what Loki kept/ })
    );

    const bar = await screen.findByTestId("log-history-unmatched");
    expect(bar).toHaveTextContent(/Loki answered with nothing for this pod/);
    expect(bar).toHaveTextContent(/labels may not match this app's query/);
    expect(bar).toHaveTextContent(/namespace\/pod/);
    expect(held(), "an unmatched query emptied the live buffer").toBe(1);
  });
});

/**
 * A workload's tab reads the pods it *had*, which is the whole reason a
 * range picker belongs on it — the pods a Deployment ran an hour ago are
 * gone from every list the API server will answer.
 */
describe("a workload's Logs tab", () => {
  beforeEach(() => {
    for (const key of Object.keys(listeners)) delete listeners[key];
    vi.clearAllMocks();
    connected();
    asMock(commands.probeLoki).mockResolvedValue({
      ok: true,
      at: Date.now(),
      latencyMs: 4,
      version: "3.1.1",
      labels: [],
    });
    asMock(commands.lokiQueryRange).mockResolvedValue(page(2));
  });

  it("asks about the workload over a range, not about the pod on screen", async () => {
    render(
      <Providers>
        <LogViewer
          {...props}
          workload={{ owner: "log-demo", ownerKind: "Deployment" }}
        />
      </Providers>
    );
    await waitFor(() => expect(listeners["stream-failed"]).toBeDefined());

    await userEvent.click(await screen.findByRole("button", { name: "6h" }));

    await waitFor(() =>
      expect(asMock(commands.lokiQueryRange)).toHaveBeenCalled()
    );
    const [selector, startMs, endMs] = asMock(commands.lokiQueryRange).mock
      .calls[0] as [string, number, number];
    // The rollout-spanning pattern, not the pod that happens to be selected:
    // two open segments after the workload's own name cover every
    // ReplicaSet it has ever had.
    expect(selector).toBe(
      '{namespace="default",pod=~"^log-demo-[^-]+-[^-]+$"}'
    );
    expect(endMs - startMs).toBe(6 * 60 * 60 * 1000);
    // And the lines a pod that no longer exists wrote land in the buffer.
    await waitFor(() => expect(held()).toBe(2));
  });
});
