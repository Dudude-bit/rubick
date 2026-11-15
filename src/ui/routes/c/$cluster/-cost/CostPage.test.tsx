import { screen, within } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import type { CostBasis, NodeBasis } from "@/generated/types";
import type { CostState } from "@/hooks/useCost";
import {
  GIB,
  estimatePicture,
  formatMoney,
  readingPicture,
  type CostReading,
} from "@/lib/cost";
import type { UsageReading } from "@/lib/efficiency";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";
import { vendorLink } from "@/lib/links";
import userEvent from "@testing-library/user-event";

const cost = vi.fn<() => CostState>();
const usage = vi.fn<() => UsageReading>();

vi.mock("@/hooks/useCost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useCost")>()),
  useCost: () => ({ cost: cost(), basis: undefined, retry: () => {} }),
  useWorkloadUsage: () => usage(),
  useCostTrend: () => ({ state: "noSupplier" }),
}));

const { CostPage } = await import("./CostPage");
const { WorkloadCostLine } = await import("./cost-line");

const node = (name: string): NodeBasis => ({
  name,
  instanceType: "m5.large",
  cpuCapacity: 2000,
  cpuAllocatable: 1900,
  memoryCapacity: 8 * GIB,
  memoryAllocatable: 7 * GIB,
  gpus: 0,
  cpuRequested: 1000,
  memoryRequested: 2 * GIB,
  gpusRequested: 0,
});

const BASIS: CostBasis = {
  nodes: [node("node-a"), node("worker-7")],
  nodesUnread: null,
  namespaces: [
    {
      namespace: "shop",
      workloads: 1,
      pods: 2,
      cpu: 500,
      memory: GIB,
      gpus: 0,
      storageBytes: 0,
    },
  ],
  workloads: [
    {
      key: {
        namespace: "shop",
        group: "apps",
        kind: "Deployment",
        name: "web",
      },
      pods: 2,
      cpu: 500,
      memory: GIB,
      gpus: 0,
      claimBytes: 0,
    },
  ],
  rest: null,
  waiting: 3,
  unread: [],
  volumeBytes: 0,
  volumeCount: 0,
  unclaimed: [],
  volumesUnread: null,
  claimsUnread: [],
  servedFrom: "watch",
};

const READING: CostReading = {
  nodes: [
    { name: "node-a", perHour: 0.2, instanceType: "m5.large", spot: false },
  ],
  allocatedByNode: { "node-a": 0.05 },
  namespaces: { shop: { cpu: 0.03, memory: 0.02 } },
  workloads: {
    values: [[0.03, 0.02, null, null]],
    rest: [null, null, null, null],
    unplaced: [],
    unread: [],
    unlabelled: 0,
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

const opencost = readingPicture(
  BASIS,
  READING,
  { kind: "opencost", vendor: "Prometheus", endpoint: "prom.example.com" },
  null
);

const open = () =>
  renderWithRouter(<CostPage />, {
    at: "/c/prod/cost",
    route: "/c/$cluster/cost",
  });

beforeEach(() => {
  useClusterStore.setState({
    currentContext: "prod",
    isConnected: true,
    namespaceScope: [],
  });
  usage.mockReturnValue({ state: "noSupplier" });
});

afterEach(() => {
  useClusterStore.setState({ currentContext: null, isConnected: false });
});

describe("the Cost page", () => {
  /** Neither source is its own screen: the way to each, never a zero. */
  it("says what either source would give, with the way to each, when there is neither", async () => {
    cost.mockReturnValue({ state: "nothing" });
    await open();
    const nothing = screen.getByTestId("cost-nothing");
    expect(
      within(nothing).getByRole("link", { name: /Integrations/ })
    ).toHaveAttribute("href", "/c/prod/integrations");
    expect(
      within(nothing).getByRole("button", { name: "enter prices" })
    ).toBeInTheDocument();
    expect(screen.queryByTestId("cost-per-hour")).toBeNull();
  });

  /** A Prometheus with no cost series names what is missing and offers prices. */
  it("names the series a connected Prometheus lacks, and offers prices", async () => {
    cost.mockReturnValue({
      state: "supplier",
      trouble: {
        kind: "noSeries",
        vendor: "Prometheus",
        endpoint: "prom.example.com",
      },
    });
    await open();
    const said = screen.getByTestId("cost-supplier");
    expect(said).toHaveTextContent("node_total_hourly_cost");
    expect(
      within(said).getByRole("button", { name: "enter prices" })
    ).toBeInTheDocument();
  });

  /**
   * A probe's answer is cached and never retried on its own: the sentence
   * that says the supplier did not answer has to offer to ask again, and the
   * supplier's Connection tab. Without them it said so for as long as the
   * page was open after Prometheus came back.
   */
  it("keeps the server's words when the supplier did not answer, and offers to ask again", async () => {
    const askAgain = vi.fn();
    cost.mockReturnValue({
      state: "supplier",
      trouble: {
        kind: "unreachable",
        vendor: "Prometheus",
        endpoint: "prom.example.com",
        said: "dial tcp 10.0.0.9:9090: connection refused",
        power: {
          state: "unreachable",
          vendor: "Prometheus",
          endpoint: "prom.example.com",
          reason: "dial tcp 10.0.0.9:9090: connection refused",
          askAgain,
          asking: false,
          settings: vendorLink("prometheus", { tab: "connection" }),
        },
      },
    });
    await open();
    const said = screen.getByTestId("cost-supplier");
    expect(said).toHaveTextContent(
      "dial tcp 10.0.0.9:9090: connection refused"
    );
    await userEvent.click(
      within(said).getByRole("button", { name: "Ask again" })
    );
    expect(askAgain).toHaveBeenCalledOnce();
    expect(
      within(said).getByRole("link", { name: "Prometheus connection" })
    ).toHaveAttribute("href", "/c/prod/integrations/prometheus?tab=connection");
  });

  /**
   * A node OpenCost does not price makes the total "at least" and is named:
   * a total over the priced ones alone would read as the whole bill.
   */
  it("calls the total at least and names the node OpenCost does not price", async () => {
    cost.mockReturnValue({
      state: "picture",
      picture: opencost,
      trouble: null,
    });
    await open();
    expect(screen.getByTestId("cost-per-hour")).toHaveTextContent(/at least/);
    expect(screen.getByTestId("cost-notes")).toHaveTextContent("worker-7");
    expect(screen.getByTestId("cost-notes")).toHaveTextContent(
      /3 pods wait for a node/
    );
  });

  /**
   * Series there by name and without the labels the page joins on would
   * otherwise read as "no series": the page names the labels instead.
   */
  it("names the labels OpenCost's series lack rather than calling them absent", async () => {
    cost.mockReturnValue({
      state: "picture",
      picture: { ...opencost, missingLabels: ["node"] },
      trouble: null,
    });
    await open();
    expect(screen.getByTestId("cost-notes")).toHaveTextContent(
      "lack the labels this page joins them on: node"
    );
  });

  /** No node priced: idle says it is not known, never 0. */
  it("says idle is not known while no node carries a price", async () => {
    const unpriced = readingPicture(
      BASIS,
      { ...READING, nodes: [], allocatedByNode: {} },
      { kind: "opencost", vendor: "Prometheus", endpoint: "prom.example.com" },
      null
    );
    cost.mockReturnValue({
      state: "picture",
      picture: unpriced,
      trouble: null,
    });
    await open();
    const idle = screen.getByTestId("cost-idle");
    expect(idle).toHaveTextContent("Not known");
    expect(idle.parentElement).toHaveTextContent(
      "Not known while no node carries a price."
    );
  });

  /** An estimate beside a failed supplier says both: what failed, and what is shown. */
  it("says why it is an estimate when the supplier failed", async () => {
    cost.mockReturnValue({
      state: "picture",
      picture: estimatePicture(
        BASIS,
        { cpu: 0.04, memory: 0.005, storage: null, gpu: null, currency: "EUR" },
        null
      ),
      trouble: {
        kind: "failed",
        vendor: "Prometheus",
        endpoint: "prom.example.com",
        said: "query timed out",
      },
    });
    await open();
    expect(screen.getByTestId("cost-trouble")).toHaveTextContent(
      "query timed out"
    );
    expect(screen.getByTestId("cost-trouble")).toHaveTextContent(/estimate/);
    expect(
      screen.getByText(/Estimated from the prices entered for prod/)
    ).toBeInTheDocument();
  });

  /** Use nobody measured is "not measured", never 0% or 100%. */
  it("says efficiency is not measured where nothing keeps usage history", async () => {
    cost.mockReturnValue({
      state: "picture",
      picture: opencost,
      trouble: null,
    });
    await open();
    expect(
      screen.getAllByText(/not measured: needs Prometheus/).length
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/0%/)).toBeNull();
  });
});

describe("one workload's cost", () => {
  /**
   * The detail page's line and the Cost page's row are one number: given
   * the same picture, both print the same amount. Fails if either reads it
   * any other way than through `costOf` on the picture.
   */
  it("is the same amount on the Cost page's row and on the workload's own page", async () => {
    cost.mockReturnValue({
      state: "picture",
      picture: opencost,
      trouble: null,
    });
    const amount = formatMoney(opencost.workloads[0]!.perHour!, "");
    await open();
    const rows = screen.getAllByRole("row");
    const row = rows.find((r) => within(r).queryByText("web"));
    expect(row).toBeDefined();
    expect(within(row!).getByText(amount)).toBeInTheDocument();

    await renderWithRouter(
      <WorkloadCostLine
        group="apps"
        kind="Deployment"
        name="web"
        namespace="shop"
      />,
      { at: "/c/prod/deployments", route: "/c/$cluster/deployments" }
    );
    expect(screen.getByTestId("workload-cost")).toHaveTextContent(
      `${amount} per hour`
    );
  });
});
