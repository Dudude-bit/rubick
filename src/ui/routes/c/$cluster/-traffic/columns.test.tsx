import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { tableLayout, yieldedColumns } from "@/components/ui/column-shares";
import { DataTable } from "@/components/ui/data-table";
import type { AppColumnMeta } from "@/components/ui/table-features";
import type { FlowEnd, Measure } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { liveRow, MEASURES, pairRows, type FlowRow } from "@/lib/traffic";
import { renderWithRouter } from "@/test/render";
import { drawnColumns, flowColumns } from "./columns";
import { End, Figure } from "./flow-cells";

const t: T = (section, key, values) => translate("en", section, key, values);

const workload = (namespace: string, name: string): FlowEnd => ({
  is: "workload",
  key: { namespace, group: "apps", kind: "Deployment", name },
});
const service = (name: string): FlowEnd => ({
  is: "service",
  namespace: "bookinfo",
  name,
});

/** The stand's rows: names that read "bookinfo/p → bookinfo/r" when the ends are 70 px. */
function standRows(): FlowRow[] {
  const ends: FlowEnd[] = [
    workload("istio-system", "istio-ingressgateway"),
    workload("bookinfo", "productpage-v1"),
    workload("bookinfo", "reviews-v2"),
    workload("bookinfo", "reviews-v3"),
    service("ratings"),
    workload("loadgen", "loadgen"),
  ];
  const pairs: [number, number][] = [
    [5, 0],
    [0, 1],
    [1, 2],
    [1, 3],
    [2, 4],
    [3, 4],
  ];
  return pairRows({
    sources: [
      {
        id: "istio",
        name: "Istio",
        state: { says: "present" },
        measures: ["requests", "errors", "p50", "p95", "p99"],
        found: [],
        need: "needIstio",
        marks: true,
        nodeAgent: false,
        needsPods: true,
        grpcErrors: true,
      },
    ],
    window: "5m",
    answer: {
      ends,
      flows: pairs.map(([from, to]) => ({
        source: 0,
        from,
        to,
        protocols: ["http"],
        sides: ["server"],
        values: MEASURES.map((m: Measure) =>
          m === "requests" ? 0.361 : m === "errors" ? 0 : m === "p95" ? 64 : 12
        ),
        reasons: [],
        unknown: [],
      })),
      reads: [],
      observed: null,
      coverage: [],
      podsUnread: [],
      podsFailed: null,
      cut: 0,
    },
  }).rows;
}

/** The pixels each drawn column gets in a port, and the ones it hides. */
function laidOut(port: number, measured: ReadonlySet<Measure> | null) {
  const rows = standRows();
  const { columns } = drawnColumns(flowColumns(t), measured);
  const bounds = columns.map((column) => {
    const meta = column.meta as AppColumnMeta;
    const floor =
      typeof meta.floor === "function"
        ? meta.floor(t, rows as never[], null)
        : (meta.floor ?? 0);
    const ideal =
      typeof meta.ideal === "function"
        ? meta.ideal(t, rows as never[])
        : (meta.ideal ?? 0);
    return {
      id: column.id!,
      floor,
      ideal,
      yields: meta.yields,
      size: column.size ?? 150,
    };
  });
  const hidden = yieldedColumns(bounds, port);
  const shown = bounds.filter((column) => !hidden.includes(column.id));
  const layout = tableLayout(shown, port);
  const px = new Map(
    shown.map((column, i) => [
      column.id,
      (layout.shares[i] / 100) * layout.span,
    ])
  );
  return { px, hidden, bounds: new Map(bounds.map((b) => [b.id, b])) };
}

const ISTIO: ReadonlySet<Measure> = new Set([
  "requests",
  "errors",
  "p50",
  "p95",
  "p99",
]);

describe("the flows table's columns", () => {
  /**
   * At the stand's 1400 px window the table has about 1100 px: both ends get
   * the whole of their longest name before a number gets more than its
   * digits, and every number keeps its digits.
   */
  it("gives the ends their whole names and the numbers their digits at a full window", () => {
    const { px, hidden, bounds } = laidOut(1100, ISTIO);
    expect(hidden).toEqual([]);
    for (const side of ["from", "to"]) {
      // `istio-system/istio-ingressgateway` is 33 glyphs of 7.2 px.
      expect(px.get(side)!).toBeGreaterThanOrEqual(33 * 7.2);
      expect(px.get(side)!).toBeGreaterThanOrEqual(bounds.get(side)!.ideal);
    }
    for (const number of ["requests", "errorShare", "p50", "p95", "p99"])
      expect(px.get(number)!).toBeGreaterThanOrEqual(bounds.get(number)!.floor);
  });

  /**
   * Where the room runs short of every whole name, the ends take what there
   * is and the numbers stay at their digits: a number wider than its digits
   * beside a cut name is room spent on the wrong column.
   */
  it("spends room on the ends before any number gets more than its digits", () => {
    const { px, hidden, bounds } = laidOut(800, ISTIO);
    expect(hidden).toEqual([]);
    expect(px.get("from")!).toBeLessThan(bounds.get("from")!.ideal);
    for (const number of ["requests", "errorShare", "p50", "p95", "p99"])
      expect(px.get(number)!).toBeCloseTo(bounds.get(number)!.floor, 0);
    expect(px.get("from")!).toBeGreaterThan(bounds.get("from")!.floor);
  });

  /**
   * Beside an open peek the least needed numbers give way first; the ends,
   * requests and errors never do, and an end keeps a readable floor.
   */
  it("hides the least needed numbers beside a peek and never an end", () => {
    const { px, hidden } = laidOut(560, ISTIO);
    expect(hidden.length).toBeGreaterThan(0);
    for (const kept of ["from", "to", "requests", "errorShare"])
      expect(hidden).not.toContain(kept);
    expect(hidden[0]).toBe("p50");
    expect(px.get("from")!).toBeGreaterThanOrEqual(14 * 7.2);
  });

  /**
   * A column no found source can fill is an empty column as wide as the
   * rest: it is not drawn and is named instead; with a source that could not
   * be looked for, nothing is known to be unfillable.
   */
  it("does not draw a number no source here measures, and names it", () => {
    const istio = drawnColumns(flowColumns(t), ISTIO);
    expect(istio.columns.map((column) => column.id)).not.toContain("bytes");
    expect(istio.columns.map((column) => column.id)).not.toContain("drops");
    expect(istio.unfilled).toEqual(["Forwarded/s", "Bytes/s", "Drops/s"]);
    expect(drawnColumns(flowColumns(t), null).unfilled).toEqual([]);
  });
});

describe("an end in the flows table", () => {
  /** The glyph sat on a line of its own above the name: both belong to one inline box. */
  it("draws a workload's glyph inline with its name", () => {
    const { container } = render(
      <End end={workload("bookinfo", "productpage-v1")} />
    );
    const icon = screen.getByTestId("resource-ref-icon");
    const name = screen.getByTestId("resource-ref-name");
    expect(icon.parentElement).toBe(name.parentElement);
    expect(icon.parentElement).toBe(container.firstElementChild);
    expect(icon.parentElement?.className).toContain("inline-flex");
  });

  /** A Service and a workload of one name differ by a glyph alone unless the cell says so. */
  it("says a Service is a Service in words", () => {
    render(<End end={service("ratings")} />);
    const shown = screen
      .getAllByText("Service")
      .filter((word) => !word.className.includes("sr-only"));
    expect(shown).toHaveLength(1);
    expect(screen.getByTestId("resource-ref-name").textContent).toContain(
      "ratings"
    );
  });
});

describe("a share of errors in the flows table", () => {
  /**
   * The map drew the fault-abort edges red while their 100% read in the
   * table's grey, like 0%: a share is toned by the one function the edge is.
   */
  it("is toned as its edge is: red at 100%, green at 0%, grey as a floor", () => {
    const [row] = standRows();
    const tone = (cell: FlowRow["errorShare"]) => {
      const { container } = render(
        <Figure cell={cell} kind="share" row={row} />
      );
      const className = container.firstElementChild?.className ?? "";
      container.remove();
      return className;
    };
    const measured = { source: "Istio", state: "measured" as const };
    expect(tone({ ...measured, value: 1 })).toContain("text-err");
    expect(tone({ ...measured, value: 0.02 })).toContain("text-warn");
    expect(tone({ ...measured, value: 0 })).toContain("text-ok");
    expect(tone({ ...measured, value: 0, floor: true })).not.toContain(
      "text-ok"
    );
  });
});

describe("the flows table under a live stream", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, "fonts");
  });

  /**
   * Live hands the table new rows every second, names and figures that
   * change in length. Each figure a floor laid out in the document was a
   * layout of the whole page: a hundred a second, until the webview hung in
   * layout. A batch lays out nothing it already knows, and a figure nothing.
   */
  it("lays out a bounded number of times however many batches arrive", async () => {
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { status: "loaded", ready: Promise.resolve() },
    });
    // A probe put into the document and then read is one layout, however
    // many probes the read takes in.
    let dirty = false;
    let layouts = 0;
    const append = Element.prototype.append;
    vi.spyOn(Element.prototype, "append").mockImplementation(function (
      this: Element,
      ...nodes: (Node | string)[]
    ) {
      dirty = true;
      append.apply(this, nodes);
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (dirty) layouts += 1;
        dirty = false;
        return { width: (this.textContent ?? "").length * 7 } as DOMRect;
      }
    );
    const batch = (n: number): FlowRow[] =>
      Array.from({ length: 12 + (n % 5) }, (_, i) =>
        liveRow({
          from: workload("shop", `caller-${"x".repeat((n + i) % 9)}-${i}`),
          to: workload("shop", `web-${i}`),
          forwarded: 1 + ((n * 7 + i) % 97) / 10,
          dropped: (n % 3) * 0.25,
          drops: [],
          requests: 0.5 + ((n * 13 + i) % 211) / 7,
          errors: (n % 4) / 10,
          p50: (n * 3 + i) % 40,
          p95: 10 + ((n * 11 + i) % 900),
          p99: 20 + ((n * 17 + i) % 4000),
          protocols: ["HTTP/1.1"],
        })
      );
    let push: (rows: FlowRow[]) => void = () => {};
    const columns = flowColumns(t);
    function Live() {
      const [rows, setRows] = useState(() => batch(0));
      push = setRows;
      return (
        <DataTable
          columns={columns}
          data={rows}
          fill
          getRowId={(row) => row.id}
        />
      );
    }
    await renderWithRouter(<Live />, {
      at: "/c/prod/traffic",
      route: "/c/$cluster/traffic",
    });
    const first = layouts;
    for (let n = 1; n <= 100; n++) act(() => push(batch(n)));
    expect(layouts - first).toBeLessThanOrEqual(5);
    // A hundred renders of a table take seconds on a loaded machine.
  }, 60_000);
});
