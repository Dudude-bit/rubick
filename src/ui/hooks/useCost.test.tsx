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

const { useCost } = await import("./useCost");
const { useClusterStore } = await import("@/stores/clusterStore");
const { useCostPricesStore } = await import("@/stores/costPricesStore");

const BASIS: CostBasis = {
  nodes: [],
  nodesUnread: null,
  namespaces: [],
  workloads: [],
  rest: null,
  waiting: 0,
  unread: [],
  volumeBytes: 0,
  volumeCount: 0,
  unclaimed: [],
  volumesUnread: null,
  claimsUnread: [],
  servedFrom: "watch",
};

const READING: CostReading = {
  nodes: [],
  allocatedByNode: null,
  namespaces: {},
  workloads: { values: [], rest: [], unplaced: [], unread: [], unlabelled: 0 },
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
    capability.mockReturnValue(ready(async () => READING));
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
