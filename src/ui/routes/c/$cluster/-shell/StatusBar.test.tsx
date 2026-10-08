import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const whole = vi.hoisted(() => ({
  podCount: 3 as number | null,
  refused: false,
}));

vi.mock("@/hooks/useClusterSummary", () => ({
  useClusterSummary: () => ({
    namespaces: [],
    podCount: whole.podCount,
    refused: whole.refused,
    namespaceList: "listed",
    isLoading: false,
  }),
}));

/** What needs attention on screen, and across the cluster when asked for it. */
const attentions = vi.hoisted(() => ({
  here: null as unknown,
  cluster: null as unknown,
  askedCluster: 0,
}));

vi.mock("@/hooks/useAttention", () => ({
  useAttention: ({ scope }: { scope?: readonly string[] } = {}) => {
    if (scope) attentions.askedCluster += 1;
    return scope ? attentions.cluster : attentions.here;
  },
}));

const attentionOf = (total: number, complete = true) => ({
  items: [],
  total,
  checks: [],
  complete,
  worst: total > 0 ? "err" : null,
});

/** The overview of whatever scope the window is on, per test. */
const scoped = vi.hoisted(() => ({
  data: undefined as unknown,
  isPlaceholderData: false,
}));

vi.mock("@/hooks/useClusterOverview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useClusterOverview")>()),
  useScopedOverview: () => scoped,
}));

const overviewOf = (pods: number, problems: number) => ({
  counts: { pods },
  problems: Array.from({ length: problems }, () => ({})),
  problemsTruncated: 0,
});

let renewal = "scheduled";
vi.mock("@/hooks/useCredentialRenewal", () => ({
  useRenewal: () => renewal,
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { useClusterStore } from "@/stores/clusterStore";
import { StatusBar } from "./StatusBar";

beforeEach(() => {
  renewal = "scheduled";
  whole.podCount = 3;
  whole.refused = false;
  attentions.askedCluster = 0;
  attentions.here = attentionOf(0);
  attentions.cluster = attentionOf(0);
  scoped.data = overviewOf(3, 0);
  scoped.isPlaceholderData = false;
  useClusterStore.setState({
    namespaceScope: [],
    currentContext: "prod",
    isConnected: true,
    connectedThrough: "direct",
    isLoading: false,
    isAuthenticating: false,
    error: null,
    errorContext: null,
    pendingContext: null,
  });
});

describe("which way the session goes", () => {
  /** A session through kubectl is a different session: no deadline of its own, and kubectl's plugin doing the talking. The bar has to say so or the reader debugs the wrong path. */
  it("names the proxy when the app's own credentials were refused", () => {
    useClusterStore.setState({ connectedThrough: "kubectl_proxy" });
    render(
      <TooltipProvider>
        <StatusBar />
      </TooltipProvider>
    );
    expect(screen.getByText("through kubectl proxy")).toBeInTheDocument();
  });

  it("says nothing about the path when it is the ordinary one", () => {
    render(
      <TooltipProvider>
        <StatusBar />
      </TooltipProvider>
    );
    expect(screen.queryByText("through kubectl proxy")).toBeNull();
    expect(screen.getByText("3 pods")).toBeInTheDocument();
  });
});

describe("what will interrupt the reader next", () => {
  /**
   * The one renewal state worth a permanent chip: it predicts the sign-in
   * screen. The quiet states must not light it, or the line stops being read.
   */
  it("warns only when renewing quietly turned out to need a person", () => {
    renewal = "needsYou";
    render(
      <TooltipProvider>
        <StatusBar />
      </TooltipProvider>
    );
    expect(screen.getByText("sign-in needed")).toBeInTheDocument();
  });

  /** `ranOut` predicts the same interruption and so lights the same chip. */
  it("warns when the plugin kept handing back what it already had", () => {
    renewal = "ranOut";
    render(
      <TooltipProvider>
        <StatusBar />
      </TooltipProvider>
    );
    expect(screen.getByText("sign-in needed")).toBeInTheDocument();
  });

  it.each([
    "scheduled",
    "noDeadline",
    "passed",
    "failed",
    "delegated",
    "unknown",
  ])("says nothing while renewal is %s", (state) => {
    renewal = state;
    render(
      <TooltipProvider>
        <StatusBar />
      </TooltipProvider>
    );
    expect(screen.queryByText("sign-in needed")).toBeNull();
  });
});

describe("what the problem count counts", () => {
  const bar = () =>
    render(
      <TooltipProvider>
        <StatusBar />
      </TooltipProvider>
    );

  /**
   * Lena chose lena-sandbox and the bar kept saying "18 problems" about
   * other teams. Fails if the count stops following the scope, or stops
   * saying which scope it counts.
   */
  it("counts the namespace the window is on and names it", () => {
    whole.podCount = 72;
    attentions.cluster = attentionOf(18);
    scoped.data = overviewOf(2, 0);
    useClusterStore.setState({ namespaceScope: ["lena-sandbox"] });
    bar();

    const counts = screen.getByTestId("scope-counts");
    expect(counts).toHaveTextContent("2 pods");
    expect(counts).toHaveTextContent("0 problems");
    expect(counts).toHaveTextContent("in lena-sandbox");
    expect(counts).not.toHaveTextContent("18 problems");
  });

  /** Fails if the cluster-wide figure is lost rather than moved behind a hover. */
  it("keeps the whole cluster's figure on hover", async () => {
    whole.podCount = 72;
    attentions.cluster = attentionOf(18);
    scoped.data = overviewOf(2, 0);
    useClusterStore.setState({ namespaceScope: ["lena-sandbox"] });
    bar();

    await userEvent.hover(screen.getByTestId("scope-counts"));
    await waitFor(() =>
      expect(
        screen.getAllByText(/Across the whole cluster: 72 pods · 18 problems/)
      ).not.toHaveLength(0)
    );
  });

  /**
   * Hovering asked a one-namespace token for every Service, Ingress,
   * autoscaler and claim in the cluster, refused each time. Fails if the
   * whole cluster is asked once it refused this connection.
   */
  it("asks the whole cluster nothing on hover once it refused", async () => {
    whole.podCount = null;
    whole.refused = true;
    useClusterStore.setState({ namespaceScope: ["team-checkout"] });
    bar();

    await userEvent.hover(screen.getByTestId("scope-counts"));
    await waitFor(() =>
      expect(
        screen.getAllByText(/whole cluster could not be read/i)
      ).not.toHaveLength(0)
    );
    expect(attentions.askedCluster).toBe(0);
  });

  /**
   * The previous scope's answer stands in while this one is read; under this
   * scope's name it would count the wrong namespaces. Fails if it is shown.
   */
  it("shows no count while the scope's own answer is still on its way", () => {
    scoped.data = overviewOf(40, 5);
    scoped.isPlaceholderData = true;
    useClusterStore.setState({ namespaceScope: ["lena-sandbox"] });
    bar();

    const counts = screen.getByTestId("scope-counts");
    expect(counts).not.toHaveTextContent("40 pods");
    expect(counts).toHaveTextContent("not counted");
  });

  /**
   * The Overview's own total, not the backend's pod-and-workload one: the
   * bar said 0 beside a namespace whose Services had no endpoints. Fails if
   * the bar counts anything but what the panel heads.
   */
  it("counts what the Needs attention panel counts", () => {
    scoped.data = overviewOf(4, 0);
    attentions.here = attentionOf(4);
    bar();

    expect(screen.getByTestId("scope-counts")).toHaveTextContent("4 problems");
  });

  /**
   * A kind the list could not read makes a zero a partial answer. Fails if
   * the bar prints a bare "0 problems" over a scope it did not finish reading.
   */
  it("says when the count did not cover everything", () => {
    attentions.here = attentionOf(0, false);
    bar();

    const counts = screen.getByTestId("scope-counts");
    expect(counts).toHaveTextContent("not all checked");
    expect(counts).not.toHaveTextContent("0 problems");
  });
});
