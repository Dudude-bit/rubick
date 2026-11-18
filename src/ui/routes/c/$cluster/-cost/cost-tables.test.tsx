import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import type { CostBasis, WorkloadKey } from "@/generated/types";
import { GIB, readingPicture, type CostReading } from "@/lib/cost";
import type { UsageReading } from "@/lib/efficiency";
import { renderWithRouter } from "@/test/render";

/** A cluster of `namespaces`, `workloads` and `nodes`, every amount its own. */
function cluster(namespaces: number, workloads: number, nodes: number) {
  const keys: WorkloadKey[] = Array.from({ length: workloads }, (_, i) => ({
    namespace: `ns-${i % namespaces}`,
    group: "apps",
    kind: "Deployment",
    name: `workload-${i}`,
  }));
  const basis: CostBasis = {
    nodes: Array.from({ length: nodes }, (_, i) => ({
      name: `node-${i}`,
      instanceType: "m5.large",
      cpuCapacity: 4000,
      cpuAllocatable: 3900,
      memoryCapacity: 16 * GIB,
      memoryAllocatable: 15 * GIB,
      gpus: 0,
      cpuRequested: 1000 + i,
      memoryRequested: 2 * GIB,
      gpusRequested: 0,
    })),
    nodesUnread: null,
    heldUnread: null,
    jobsUnread: null,
    namespaces: Array.from({ length: namespaces }, (_, i) => ({
      namespace: `ns-${i}`,
      workloads: Math.ceil(workloads / namespaces),
      pods: 3,
      cpu: 300 + i,
      memory: GIB,
      gpus: 0,
      storageBytes: 0,
    })),
    workloads: keys.map((key, i) => ({
      key,
      pods: 2,
      cpu: 100 + i,
      memory: (128 + i) * 1024 * 1024,
      gpus: 0,
      claimBytes: 0,
    })),
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
  const reading: CostReading = {
    nodes: basis.nodes!.map((n, i) => ({
      name: n.name,
      perHour: 0.2 + i / 1000,
      instanceType: "m5.large",
      spot: false,
    })),
    allocatedByNode: Object.fromEntries(
      basis.nodes!.map((n, i) => [n.name, 0.05 + i / 1000])
    ),
    namespaces: Object.fromEntries(
      basis.namespaces.map((n, i) => [
        n.namespace,
        { cpu: 0.01 + i / 10_000, memory: 0.003 + i / 100_000 },
      ])
    ),
    workloads: {
      values: keys.map((_, i) => [
        0.001 + i / 100_000,
        0.0004 + i / 1e6,
        null,
        null,
      ]),
      rest: [null, null, null, null],
      unplaced: [],
      unread: [],
      unlabelled: 0,
      covered: [],
      since: keys.map(() => null),
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
  const picture = readingPicture(
    basis,
    reading,
    { kind: "opencost", vendor: "Prometheus", endpoint: "prom.example.com" },
    null
  );
  const usage: UsageReading = {
    state: "read",
    keys,
    fold: {
      values: keys.map((_, i) => [
        40 + i,
        90 + i,
        (60 + i) * 1024 * 1024,
        (99 + i) * 1024 * 1024,
      ]),
      rest: [null, null, null, null],
      unplaced: [],
      unread: [],
      unlabelled: 0,
      covered: [],
      since: keys.map(() => "2020-01-01T00:00:00Z"),
    },
  };
  return { picture, usage };
}

/**
 * Counts what text measuring costs: a probe put into the document and then
 * read is one layout, however many probes it read at once.
 */
function countLayouts() {
  let dirty = false;
  const counted = { layouts: 0, probes: 0 };
  const append = Element.prototype.append;
  vi.spyOn(Element.prototype, "append").mockImplementation(function (
    this: Element,
    ...nodes: (Node | string)[]
  ) {
    dirty = true;
    counted.probes += nodes.length;
    append.apply(this, nodes);
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (dirty) counted.layouts += 1;
      dirty = false;
      return { width: (this.textContent ?? "").length * 7 } as DOMRect;
    }
  );
  return counted;
}

beforeEach(() => {
  vi.resetModules();
  // The app measures after its fonts arrive, and keeps what it measured.
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { status: "loaded", ready: Promise.resolve() },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function open(namespaces: number, workloads: number, nodes: number) {
  const { CostTables } = await import("./cost-tables");
  const counted = countLayouts();
  const first = cluster(namespaces, workloads, nodes);
  const started = performance.now();
  const view = await renderWithRouter(
    <CostTables picture={first.picture} usage={first.usage} />,
    { at: "/c/prod/cost", route: "/c/$cluster/cost" }
  );
  const ms = performance.now() - started;
  /** Hands the tables `next` and says what that changed in the document. */
  const refresh = async (next: ReturnType<typeof cluster>) => {
    const changed: Node[] = [];
    const watch = new MutationObserver((records) =>
      records.forEach((r) => changed.push(r.target))
    );
    // The rows; a re-rendered toolbar sets its search box's `type` again.
    for (const body of view.container.querySelectorAll("tbody"))
      watch.observe(body, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    counted.layouts = 0;
    // Every amount a cell or a floor words goes through a number format.
    // `format` is a getter on the prototype, read once per amount.
    const formats = Intl.NumberFormat.prototype as unknown as {
      format: object;
    };
    const worded = vi.spyOn(formats, "format", "get");
    await view.rerender(
      <CostTables picture={next.picture} usage={next.usage} />
    );
    changed.push(...watch.takeRecords().map((r) => r.target));
    watch.disconnect();
    const amounts = worded.mock.calls.length;
    worded.mockRestore();
    return { changed, layouts: counted.layouts, amounts };
  };
  return { counted: { ...counted }, ms, refresh };
}

describe("the Cost page's breakdowns", () => {
  /**
   * The first open stalled the window: every amount was laid out on its own
   * against the whole page, 323 layouts for 12 namespaces and 40 workloads
   * and 3345 at the 600-row cap. Measuring goes by shape, in one batch per
   * column, so the cap costs what the stand costs. Fails if a row, or a
   * digit, buys a layout again.
   */
  it(
    "lays text out as often at the 600-row cap as at a dozen rows",
    { timeout: 60_000 },
    async () => {
      const stand = await open(12, 40, 2);
      vi.restoreAllMocks();
      vi.resetModules();
      const cap = await open(40, 600, 20);
      console.log(
        `first open: stand ${stand.counted.layouts} layouts, ${stand.counted.probes} probes, ${stand.ms.toFixed(0)} ms; cap ${cap.counted.layouts} layouts, ${cap.counted.probes} probes, ${cap.ms.toFixed(0)} ms`
      );
      expect(stand.counted.layouts).toBeLessThanOrEqual(45);
      expect(cap.counted.layouts).toBeLessThanOrEqual(stand.counted.layouts);
      expect(cap.counted.probes).toBeLessThan(200);
    }
  );

  /**
   * A 15-second refresh that brings the same numbers rebuilt every row:
   * each was a new object, so every row redrew and every floor was worded
   * again. Fails if an answer that moved nothing words an amount, changes
   * the document or lays anything out.
   */
  it(
    "does no work when a refresh brings the same numbers",
    { timeout: 60_000 },
    async () => {
      const { refresh } = await open(12, 40, 2);
      const { changed, layouts, amounts } = await refresh(cluster(12, 40, 2));
      expect(amounts).toBe(0);
      expect(changed).toEqual([]);
      expect(layouts).toBe(0);
    }
  );

  /**
   * Work follows the change: one workload's cost moving words and redraws
   * its row and leaves the other 39 alone. Fails if a moved amount words
   * or redraws the table.
   */
  it("redraws only the row whose cost moved", { timeout: 60_000 }, async () => {
    const { refresh } = await open(12, 40, 2);
    const next = cluster(12, 40, 2);
    const moved = next.picture.workloads[7]!;
    next.picture = {
      ...next.picture,
      workloads: next.picture.workloads.map((w) =>
        w === moved ? { ...w, perHour: (w.perHour ?? 0) + 1 } : w
      ),
    };
    const { changed, amounts } = await refresh(next);
    console.log(`one row moved: ${amounts} amounts worded`);
    expect(amounts).toBeLessThan(40);
    const rows = new Set(
      changed.map((node) =>
        (node instanceof Element ? node : node.parentElement)?.closest("tr")
      )
    );
    expect(changed.length).toBeGreaterThan(0);
    expect(rows.size).toBe(1);
    expect([...rows][0]).toHaveTextContent("workload-7");
  });
});
