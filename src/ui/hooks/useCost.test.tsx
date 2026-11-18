import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import type { CostBasis } from "@/generated/types";
import type { CostReading, Prices } from "@/lib/cost";

const capability = vi.fn();
const costBasis = vi.fn<() => Promise<CostBasis>>();

vi.mock("@/integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/integrations")>()),
  useCapabilityState: () => capability(),
}));
vi.mock("@/lib/commands", () => ({
  commands: { costBasis: () => costBasis() },
}));

const { useCost, useCostTrend, useWorkloadUsage, rowsKey } =
  await import("./useCost");
const { useClusterStore } = await import("@/stores/clusterStore");
const { useCostPricesStore } = await import("@/stores/costPricesStore");

const BASIS: CostBasis = {
  nodes: [],
  nodesUnread: null,
  heldUnread: null,
  jobsUnread: null,
  namespaces: [],
  workloads: [],
  rest: null,
  waiting: 0,
  unread: [],
  volumeBytes: 0,
  volumeCount: 0,
  unclaimed: { count: 0, bytes: 0 },
  volumesUnread: null,
  claimsUnread: [],
  servedFrom: "watch",
};

const READING: CostReading = {
  nodes: [],
  allocatedByNode: null,
  namespaces: {},
  workloads: {
    values: [],
    rest: [],
    unplaced: [],
    unread: [],
    unlabelled: 0,
    covered: [],
    pods: [],
    since: [],
  },
  storage: {
    total: null,
    unclaimed: null,
    priced: true,
    unpriced: [],
    unsized: [],
  },
  fee: null,
  loadBalancers: null,
  missingLabels: [],
};

const PRICES: Prices = {
  cpu: 0.04,
  memory: 0.005,
  storage: null,
  gpu: null,
  currency: "EUR",
};

const ready = (use: () => Promise<CostReading | null>) => ({
  state: "ready",
  vendor: "Prometheus",
  endpoint: "prom.example.com",
  use,
  page: null,
});

function render() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useCost(null), { wrapper });
}

beforeEach(() => {
  costBasis.mockReset();
  costBasis.mockResolvedValue(BASIS);
  useClusterStore.setState({ currentContext: "prod", isConnected: true });
  useCostPricesStore.setState({ prices: {} });
});

afterEach(() => {
  useClusterStore.setState({ currentContext: null, isConnected: false });
});

describe("which source a cost is read from", () => {
  /** Neither source: the page says what each would give, not "0". */
  it("is nothing where no supplier is connected and no prices are entered", async () => {
    capability.mockReturnValue({ state: "absent" });
    const hook = render();
    expect(hook.result.current.cost.state).toBe("nothing");
    expect(costBasis).not.toHaveBeenCalled();
  });

  /** A configured supplier still being asked is not "none connected". */
  it("waits while the configured supplier's probe is out", async () => {
    capability.mockReturnValue({ state: "reading" });
    useCostPricesStore.setState({ prices: { prod: PRICES } });
    const hook = render();
    // Even once what the cluster holds is read, entered prices wait for it.
    await waitFor(() => expect(hook.result.current.basis).toBeDefined());
    expect(hook.result.current.cost.state).toBe("loading");
  });

  /** OpenCost answering wins over entered prices: they are not mixed. */
  it("reads OpenCost's prices where its series answer, prices entered or not", async () => {
    costBasis.mockResolvedValue({
      ...BASIS,
      nodes: [
        {
          name: "node-a",
          instanceType: null,
          cpuCapacity: 2000,
          cpuAllocatable: 1900,
          memoryCapacity: 8 * 1024 ** 3,
          memoryAllocatable: 7 * 1024 ** 3,
          gpus: 0,
          cpuRequested: null,
          memoryRequested: null,
          gpusRequested: null,
        },
      ],
    });
    capability.mockReturnValue(
      ready(async () => ({
        ...READING,
        nodes: [
          { name: "node-a", perHour: 0.2, instanceType: null, spot: null },
        ],
      }))
    );
    useCostPricesStore.setState({ prices: { prod: PRICES } });
    const hook = render();
    await waitFor(() => expect(hook.result.current.cost.state).toBe("picture"));
    const cost = hook.result.current.cost;
    expect(cost.state === "picture" && cost.picture.source.kind).toBe(
      "opencost"
    );
  });

  /**
   * A Prometheus without OpenCost's series beside entered prices: the
   * estimate, with the reason the supplier gave none said above it.
   */
  it("estimates from prices and says why where the supplier holds no series", async () => {
    capability.mockReturnValue(ready(async () => null));
    useCostPricesStore.setState({ prices: { prod: PRICES } });
    const hook = render();
    await waitFor(() => expect(hook.result.current.cost.state).toBe("picture"));
    const cost = hook.result.current.cost;
    expect(cost.state === "picture" && cost.picture.source.kind).toBe(
      "estimate"
    );
    expect(cost.state === "picture" && cost.trouble?.kind).toBe("noSeries");
  });

  /**
   * OpenCost on kind prices no node. Entered prices then fill that in, and
   * the picture says why it is an estimate; without prices it stays
   * OpenCost's, whose page says what to do.
   */
  it("estimates from prices where OpenCost prices no node, and says why", async () => {
    capability.mockReturnValue(ready(async () => READING));
    useCostPricesStore.setState({ prices: { prod: PRICES } });
    const hook = render();
    await waitFor(() => expect(hook.result.current.cost.state).toBe("picture"));
    const cost = hook.result.current.cost;
    expect(cost.state === "picture" && cost.picture.source.kind).toBe(
      "estimate"
    );
    expect(cost.state === "picture" && cost.trouble?.kind).toBe("noNodePrices");
  });

  /**
   * A re-render with nothing new keeps the picture: the tables beneath it
   * re-derive their rows and widths only when it changes.
   */
  it("keeps the picture across renders while nothing it is made of changed", async () => {
    const answer = ready(async () => ({
      ...READING,
      nodes: [{ name: "node-a", perHour: 0.2, instanceType: null, spot: null }],
    }));
    capability.mockReturnValue(answer);
    const hook = render();
    await waitFor(() => expect(hook.result.current.cost.state).toBe("picture"));
    const first = hook.result.current.cost;
    hook.rerender();
    hook.rerender();
    expect(hook.result.current.cost).toBe(first);
  });

  /**
   * The Prometheus behind a cluster changed: its answer sat under the old
   * one's key, and the page showed the old supplier's cost as the new one's
   * until the next read. Fails if one supplier's answer stands in for
   * another's, even while the other is read.
   */
  it("shows no supplier's answer as another's while the other is read", async () => {
    capability.mockReturnValue(
      ready(async () => ({
        ...READING,
        nodes: [
          { name: "node-a", perHour: 0.2, instanceType: null, spot: null },
        ],
      }))
    );
    const hook = render();
    await waitFor(() => expect(hook.result.current.cost.state).toBe("picture"));
    capability.mockReturnValue({
      ...ready(() => new Promise(() => {})),
      endpoint: "other.example.com",
    });
    hook.rerender();
    await waitFor(() => expect(hook.result.current.cost.state).toBe("loading"));
  });

  /**
   * From namespace `a` to `b`: while `b`'s read was out the page kept `a`'s
   * answer, and the table under `b` listed `a`'s workloads. An answer is
   * kept only within its own scope. Fails if one scope's answer stands in
   * for another's.
   */
  it("shows no scope's answer as another's while the other is read", async () => {
    capability.mockReturnValue(
      ready(async () => ({
        ...READING,
        nodes: [
          { name: "node-a", perHour: 0.2, instanceType: null, spot: null },
        ],
      }))
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const hook = renderHook(
      ({ scope }: { scope: string[] }) => useCost(scope),
      { wrapper, initialProps: { scope: ["a"] } }
    );
    await waitFor(() => expect(hook.result.current.cost.state).toBe("picture"));
    capability.mockReturnValue(ready(() => new Promise(() => {})));
    hook.rerender({ scope: ["b"] });
    await waitFor(() => expect(hook.result.current.basis).toBeDefined());
    expect(hook.result.current.cost.state).toBe("loading");
  });

  /**
   * The cost basis failed and Retry was pressed: it asked the supplier too,
   * with no rows to ask against, and kept an answer with no basis that the
   * picture fell over later. Fails if Retry asks the supplier without one.
   */
  it("asks the supplier again only with a basis to ask against", async () => {
    const use = vi.fn(async () => READING);
    capability.mockReturnValue(ready(use));
    costBasis.mockRejectedValue(new Error("pods is forbidden"));
    const hook = render();
    await waitFor(() =>
      expect(hook.result.current.cost.state).toBe("basisFailed")
    );
    act(() => hook.result.current.retry());
    await waitFor(() => expect(costBasis).toHaveBeenCalledTimes(2));
    expect(use).not.toHaveBeenCalled();
  });

  /** No series and no prices is its own sentence, not "nothing set up". */
  it("says the supplier holds no series where no prices are entered", async () => {
    capability.mockReturnValue(ready(async () => null));
    const hook = render();
    await waitFor(() =>
      expect(hook.result.current.cost.state).toBe("supplier")
    );
    const cost = hook.result.current.cost;
    expect(cost.state === "supplier" && cost.trouble.kind).toBe("noSeries");
  });

  /** A failed read keeps the server's words, never an empty picture. */
  it("carries the supplier's failure in its own words", async () => {
    capability.mockReturnValue(
      ready(async () => {
        throw new Error("query timed out in expression evaluation");
      })
    );
    const hook = render();
    await waitFor(() =>
      expect(hook.result.current.cost.state).toBe("supplier")
    );
    const cost = hook.result.current.cost;
    expect(cost.state === "supplier" && cost.trouble).toMatchObject({
      kind: "failed",
      said: expect.stringContaining("query timed out"),
    });
  });

  it("says the supplier did not answer, with the probe's reason", async () => {
    capability.mockReturnValue({
      state: "unreachable",
      vendor: "Prometheus",
      endpoint: "prom.example.com",
      reason: "connection refused",
    });
    useCostPricesStore.setState({ prices: { prod: PRICES } });
    const hook = render();
    await waitFor(() => expect(hook.result.current.cost.state).toBe("picture"));
    const cost = hook.result.current.cost;
    expect(cost.state === "picture" && cost.trouble).toMatchObject({
      kind: "unreachable",
      said: "connection refused",
    });
  });

  /** The basis failing is not a cluster that costs nothing. */
  it("says the basis could not be read rather than drawing an empty picture", async () => {
    capability.mockReturnValue({ state: "absent" });
    useCostPricesStore.setState({ prices: { prod: PRICES } });
    costBasis.mockRejectedValue(new Error("forbidden"));
    const hook = render();
    await waitFor(() =>
      expect(hook.result.current.cost.state).toBe("basisFailed")
    );
    await act(async () => {});
  });
});

describe("the rows a reading is keyed on", () => {
  /**
   * Two custom kinds of one name in two API groups are two workloads: the
   * key that says the rows changed told them apart only by namespace, kind
   * and name, so the page kept the first one's cost for the second.
   */
  it("tells workloads apart by their API group", () => {
    const of = (group: string) => [
      { namespace: "prod", group, kind: "Worker", name: "api" },
    ];
    expect(rowsKey(of("first.example"))).not.toBe(
      rowsKey(of("second.example"))
    );
  });
});

describe("a read that failed after one that answered", () => {
  /**
   * React Query keeps the last answer when a re-read fails, and each hook
   * looked at the answer before the error: a 403 or a timeout left the page
   * showing the old figures as current. The cost keeps them and says the
   * latest read failed; use and the trend say they failed. Fails if a
   * failed re-read is hidden behind the read before it.
   */
  it("says the latest read failed, beside the figures it kept", async () => {
    let answers = true;
    capability.mockReturnValue(
      ready(async () => {
        if (!answers) throw new Error("query timed out");
        return {
          ...READING,
          nodes: [
            { name: "node-a", perHour: 0.2, instanceType: null, spot: null },
          ],
        };
      })
    );
    const hook = render();
    await waitFor(() => expect(hook.result.current.cost.state).toBe("picture"));
    answers = false;
    act(() => hook.result.current.retry());
    await waitFor(() => {
      const cost = hook.result.current.cost;
      expect(cost.state === "picture" && cost.trouble).toMatchObject({
        kind: "lastFailed",
        said: "query timed out",
      });
    });
  });

  /**
   * OpenCost priced no node and prices were entered, so the estimate is
   * drawn; a re-read that then failed went unsaid behind the reason for the
   * estimate. Fails if the estimate branch drops the failed re-read.
   */
  it("says the latest read failed beside the estimate it drew for want of node prices", async () => {
    let answers = true;
    capability.mockReturnValue(
      ready(async () => {
        if (!answers) throw new Error("query timed out");
        return READING;
      })
    );
    useCostPricesStore.setState({ prices: { prod: PRICES } });
    const hook = render();
    await waitFor(() => {
      const cost = hook.result.current.cost;
      expect(cost.state === "picture" && cost.trouble).toMatchObject({
        kind: "noNodePrices",
        lastFailed: null,
      });
    });
    answers = false;
    act(() => hook.result.current.retry());
    await waitFor(() => {
      const cost = hook.result.current.cost;
      expect(cost.state === "picture" && cost.trouble).toMatchObject({
        kind: "noNodePrices",
        lastFailed: "query timed out",
      });
    });
  });

  /**
   * A day of a young pod is judged when the reading was taken, and the
   * reading is taken again on its poll even when Prometheus answers the
   * same: Audit's "young" turns into a verdict on the first read past the
   * day. Fails if `at` stays at the first read while the answer repeats.
   */
  it("moves when it was read on a re-read that answers the same", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const key = {
      namespace: "shop",
      group: "apps",
      kind: "Deployment",
      name: "web",
    };
    capability.mockReturnValue(
      ready(
        async () =>
          ({
            ...READING.workloads,
            values: [[1, 2, 3, 4]],
            since: [null],
          }) as never
      )
    );
    const usage = renderHook(() => useWorkloadUsage(["shop"], [key]), {
      wrapper,
    });
    await waitFor(() => expect(usage.result.current.state).toBe("read"));
    const first = (usage.result.current as { at: number }).at;
    const later = first + 25 * 3_600_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(later);
    await act(() => client.refetchQueries());
    await waitFor(() =>
      expect(usage.result.current).toMatchObject({ at: later })
    );
    now.mockRestore();
  });

  it("says use and the trend failed rather than showing the read before", async () => {
    let answers = true;
    const answer = async (value: unknown) => {
      if (!answers) throw new Error("query timed out");
      return value;
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const key = {
      namespace: "shop",
      group: "apps",
      kind: "Deployment",
      name: "web",
    };
    capability.mockReturnValue(
      ready(
        () =>
          answer({
            ...READING.workloads,
            values: [[1, 2, 3, 4]],
            since: [null],
          }) as never
      )
    );
    const usage = renderHook(() => useWorkloadUsage(["shop"], [key]), {
      wrapper,
    });
    await waitFor(() => expect(usage.result.current.state).toBe("read"));
    // When it was read travels with it: what it covers is judged then.
    expect(usage.result.current).toMatchObject({ at: expect.any(Number) });
    capability.mockReturnValue(
      ready(() => answer({ points: [], stepSeconds: 300 }) as never)
    );
    const trend = renderHook(() => useCostTrend(null, "24h", null), {
      wrapper,
    });
    await waitFor(() => expect(trend.result.current.state).toBe("read"));

    answers = false;
    await act(() => client.refetchQueries());
    await waitFor(() => expect(trend.result.current.state).toBe("failed"));
    capability.mockReturnValue(ready(() => answer(null) as never));
    usage.rerender();
    await waitFor(() => expect(usage.result.current.state).toBe("failed"));
  });
});
