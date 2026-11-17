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
const { NamespaceCostLine, WorkloadCostLine } = await import("./cost-line");

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
  heldUnread: null,
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
    since: [null],
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

  /**
   * A token that lists the nodes and only `shop`'s pods: the nodes were read,
   * so the cluster's total and `shop`'s share of it stand, and only idle is
   * unknown, with the refusal named. Fails if the refused pod list took the
   * nodes with it ("there is no cluster total"), or idle read as 0.
   */
  it("keeps the cluster total when only what the nodes hold could not be counted", async () => {
    const uncounted = {
      cpuRequested: null,
      memoryRequested: null,
      gpusRequested: null,
    };
    const picture = estimatePicture(
      {
        ...BASIS,
        nodes: BASIS.nodes!.map((n) => ({ ...n, ...uncounted })),
        heldUnread: {
          code: "PERMISSION_DENIED",
          message: "pods is forbidden at the cluster scope",
        },
      },
      { cpu: 0.04, memory: 0.005, storage: null, gpu: null, currency: "" },
      ["shop"]
    );
    cost.mockReturnValue({ state: "picture", picture, trouble: null });
    useClusterStore.setState({ namespaceScope: ["shop"] });
    await open();
    expect(screen.getByText(/of the cluster/)).toBeInTheDocument();
    expect(screen.getByTestId("cost-idle")).toHaveTextContent("Not known");
    const notes = screen.getByTestId("cost-notes");
    expect(notes).toHaveTextContent(
      "What each node holds could not be counted (pods is forbidden at the cluster scope), so idle is not known."
    );
    expect(notes).not.toHaveTextContent("There is no cluster total");
  });

  /**
   * A shared Prometheus prices another cluster's nodes too: the page says
   * which, and that they are not in its totals. Fails if they were left
   * out silently, or the note named this cluster's own nodes.
   */
  it("names the nodes Prometheus prices that this cluster does not list", async () => {
    const shared = readingPicture(
      BASIS,
      {
        ...READING,
        nodes: [
          ...READING.nodes,
          { name: "staging-1", perHour: 0.5, instanceType: null, spot: null },
        ],
      },
      { kind: "opencost", vendor: "Prometheus", endpoint: "prom.example.com" },
      null
    );
    cost.mockReturnValue({ state: "picture", picture: shared, trouble: null });
    await open();
    expect(screen.getByTestId("cost-notes")).toHaveTextContent(
      "Prometheus at prom.example.com also prices 1 node this cluster does not list: staging-1. It is left out of the totals"
    );
  });

  /**
   * "Carries no price in OpenCost" is true and says neither why nor what to
   * do: OpenCost found no price list, and either it is given custom pricing
   * or prices are entered here.
   */
  it("says why OpenCost priced no node and offers to enter prices", async () => {
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
    const why = screen.getByTestId("cost-why-unpriced");
    expect(why).toHaveTextContent("found no price list");
    expect(why).toHaveTextContent("custom pricing");
    expect(
      within(why).getByRole("button", { name: "enter prices" })
    ).toBeInTheDocument();
  });

  /** Some nodes priced: custom pricing is the way, entered prices would not apply. */
  it("points at OpenCost's custom pricing where only some nodes carry no price", async () => {
    cost.mockReturnValue({
      state: "picture",
      picture: opencost,
      trouble: null,
    });
    await open();
    const why = screen.getByTestId("cost-why-unpriced");
    expect(why).toHaveTextContent("custom pricing for them");
    expect(within(why).queryByRole("button")).toBeNull();
  });

  /**
   * The namespace's icon sat on a line of its own above its name. The
   * reference is drawn inline, in the shell the app's lists draw one in.
   */
  it("draws each namespace as an inline reference, as the lists do", async () => {
    cost.mockReturnValue({
      state: "picture",
      picture: opencost,
      trouble: null,
    });
    await open();
    const shop = screen
      .getAllByRole("link")
      .find((link) => link.textContent === "Namespace shop")!;
    expect(shop.className).toContain("inline-flex");
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

  /**
   * A workload rolled out two hours ago is read over those two hours, and
   * says so; its low peak is not toned as asking for too much. Fails if the
   * figures claimed the whole day, or a young peak was marked.
   */
  it("says a young workload's figures cover only its pods' hours, and does not mark it", async () => {
    cost.mockReturnValue({
      state: "picture",
      picture: opencost,
      trouble: null,
    });
    const started = new Date(Date.now() - 121 * 60_000).toISOString();
    usage.mockReturnValue({
      state: "read",
      keys: [BASIS.workloads[0]!.key],
      fold: {
        values: [[50, 100, 0.1 * GIB, 0.2 * GIB]],
        rest: [],
        unplaced: [],
        unread: [],
        unlabelled: 0,
        since: [started],
      },
    });
    await open();
    const [cpu] = screen.getAllByText(/^CPU 10% average, 20% peak, over 2h$/);
    expect(cpu).not.toHaveClass("text-warn");
    expect(cpu).toHaveAttribute(
      "title",
      expect.stringContaining("started 2h ago")
    );
    expect(
      screen.getAllByText(/^50m average · 100m peak, over 2h$/).length
    ).toBeGreaterThan(0);
  });
});

describe("a namespace no OpenCost series prices", () => {
  /**
   * `ml` runs pods on a node OpenCost has no price for, so the join drops
   * every one of its series. Its row stays on the page and its own line
   * says it is not priced. Fails if either read the missing series as
   * nothing running on a node.
   */
  it("keeps its row and says it is not priced, never that nothing runs", async () => {
    const ml = {
      namespace: "ml",
      workloads: 1,
      pods: 2,
      cpu: 2000,
      memory: 4 * GIB,
      gpus: 0,
      storageBytes: 0,
    };
    const picture = readingPicture(
      { ...BASIS, namespaces: [...BASIS.namespaces, ml] },
      READING,
      { kind: "opencost", vendor: "Prometheus", endpoint: "prom.example.com" },
      ["ml"]
    );
    cost.mockReturnValue({ state: "picture", picture, trouble: null });
    useClusterStore.setState({ namespaceScope: ["ml"] });
    await open();
    const [, row] = screen.getAllByRole("row");
    expect(row).toHaveTextContent(/^Namespace mlnot priced/);
    expect(
      screen.queryByText("Nothing in this scope runs on a node.")
    ).toBeNull();

    await renderWithRouter(<NamespaceCostLine namespace="ml" />, {
      at: "/c/prod/namespaces",
      route: "/c/$cluster/namespaces",
    });
    expect(screen.getByTestId("namespace-cost")).toHaveTextContent(
      "No OpenCost series priced its pods."
    );
  });
});

describe("the window on one namespace", () => {
  /**
   * A namespace-bound reader with prices entered, the window on `shop`: the
   * by-namespace table drew one row of amounts and nothing saying whose,
   * because one namespace chosen hides every Namespace column. There it is
   * the row's own name; the by-workload table, where it repeats beside
   * each name, still drops it. Fails if either table changes sides.
   */
  it("names the namespace on its row, and drops it beside each workload", async () => {
    cost.mockReturnValue({
      state: "picture",
      picture: estimatePicture(
        BASIS,
        { cpu: 0.04, memory: 0.005, storage: null, gpu: null, currency: "EUR" },
        ["shop"]
      ),
      trouble: null,
    });
    useClusterStore.setState({ namespaceScope: ["shop"] });
    await open();
    const headers = screen
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers.filter((h) => h === "Namespace")).toHaveLength(1);
    const [, row] = screen.getAllByRole("row");
    expect(
      within(row!).getByRole("link", { name: /shop/ })
    ).toBeInTheDocument();
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

  /**
   * A running Job a CronJob made said on its own page that nothing of it ran
   * on a node: its pods are billed to the CronJob's row, and the line looked
   * for the Job's. It reads the CronJob's row and says whose it is.
   */
  it("reads a CronJob's run from the CronJob's row, and says so", async () => {
    const withCron = readingPicture(
      {
        ...BASIS,
        workloads: [
          {
            key: {
              namespace: "ops",
              group: "batch",
              kind: "CronJob",
              name: "backup",
            },
            pods: 1,
            cpu: 500,
            memory: GIB,
            gpus: 0,
            claimBytes: 0,
          },
        ],
      },
      READING,
      { kind: "opencost", vendor: "Prometheus", endpoint: "prom.example.com" },
      null
    );
    cost.mockReturnValue({
      state: "picture",
      picture: withCron,
      trouble: null,
    });
    await renderWithRouter(
      <WorkloadCostLine
        group="batch"
        kind="Job"
        name="backup-29"
        namespace="ops"
        billedTo={{ group: "batch", kind: "CronJob", name: "backup" }}
      />,
      { at: "/c/prod/jobs", route: "/c/$cluster/jobs" }
    );
    const line = screen.getByTestId("workload-cost");
    expect(line).toHaveTextContent("Billed to CronJob backup:");
    expect(line).toHaveTextContent(
      `${formatMoney(withCron.workloads[0]!.perHour!, "")} per hour`
    );
  });

  /** The line is drawn beside running pods: no row is never "nothing runs". */
  it("never says nothing runs for a running workload it has no row for", async () => {
    cost.mockReturnValue({
      state: "picture",
      picture: opencost,
      trouble: null,
    });
    await renderWithRouter(
      <WorkloadCostLine
        group="apps"
        kind="Deployment"
        name="new"
        namespace="shop"
      />,
      { at: "/c/prod/deployments", route: "/c/$cluster/deployments" }
    );
    const line = screen.getByTestId("workload-cost");
    expect(line).toHaveTextContent("Not in the cost read yet.");
    expect(line).not.toHaveTextContent(/runs on a node/);
  });
});
