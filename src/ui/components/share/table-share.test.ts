import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import { columnHeader } from "@/i18n/column-header";
import type { T } from "@/i18n/useT";
import { columns as nodeColumns } from "@/routes/c/$cluster/(cluster)/nodes/-components/NodeList";
import { columns as podColumns } from "@/routes/c/$cluster/(workloads)/pods/-components/PodList";
import { tableSection } from "./table-share";

const t: T = (section, key, values) => translate("en", section, key, values);
const ru: T = (section, key, values) => translate("ru", section, key, values);

interface Col {
  id: string;
  columnDef: { header?: unknown; meta?: unknown; accessorKey?: string };
}

const column = (id: string): Col => ({
  id,
  columnDef: { header: id, accessorKey: id },
});

function tableOf(rows: Record<string, unknown>[], columns: (string | Col)[]) {
  const cols = columns.map((c) => (typeof c === "string" ? column(c) : c));
  return {
    getVisibleFlatColumns: () => cols,
    getRowModel: () => ({
      rows: rows.map((original) => ({
        original,
        getVisibleCells: () =>
          cols.map((col) => ({
            column: col,
            getValue: () => original[col.id],
          })),
      })),
    }),
  };
}

const tableOfSection = (section: ReturnType<typeof tableSection>) => {
  if (section.body.type !== "table") throw new Error("expected a table");
  return section.body;
};

describe("the cells a shared table writes", () => {
  /** `Date.parse("110")` is a date in V8, so a chart version or a port was
   *  written into the file as a timestamp. */
  it("writes a version or a port as itself and only an ISO time as a time", () => {
    const section = tableSection(
      tableOf(
        [
          {
            name: "web",
            chart: "110",
            appVersion: "1.2.3",
            lastSeen: "2026-09-25T10:00:00Z",
          },
        ],
        ["chart", "appVersion", "lastSeen"]
      ),
      { title: "Releases" },
      t
    );
    const [, chart, version, seen] = tableOfSection(section).rows[0].cells;
    expect(chart).toEqual({ text: "110", mono: true });
    expect(version).toEqual({ text: "1.2.3", mono: true });
    expect(seen).toEqual({
      text: "2026-09-25T10:00:00Z",
      at: "2026-09-25T10:00:00Z",
    });
  });

  /**
   * The Deployments list draws its replicas and its status from the row,
   * with no value behind the column; the file kept only Name and Created,
   * and `api` at 0/3 read exactly like `web` at 3/3.
   */
  it("writes what a column draws when the column says it", () => {
    const replicas: Col = {
      id: "replicas",
      columnDef: {
        header: columnHeader("columns", "replicas"),
        meta: {
          share: (row: { ready: number; desired: number }) =>
            `${row.ready}/${row.desired}`,
        },
      },
    };
    const status: Col = {
      id: "status",
      columnDef: {
        header: columnHeader("columns", "status"),
        meta: { share: (row: { state: string }) => row.state },
      },
    };
    const body = tableOfSection(
      tableSection(
        tableOf(
          [{ name: "api", ready: 0, desired: 3, state: "Progressing" }],
          [replicas, status]
        ),
        { title: "Deployments" },
        t
      )
    );
    expect(body.columns).toEqual(["Name", "Replicas", "Status"]);
    expect(body.rows[0].cells.slice(1)).toEqual([
      { text: "0/3", mono: true },
      { text: "Progressing", role: "pending" },
    ]);
  });

  /** The header the app draws, in the reader's language, not the column's id. */
  it("names each column in the reader's language", () => {
    const modes: Col = {
      id: "accessModes",
      columnDef: {
        header: columnHeader("columns", "accessModes"),
        accessorKey: "accessModes",
      },
    };
    const body = tableOfSection(
      tableSection(
        tableOf([{ name: "data", accessModes: ["RWO"] }], [modes]),
        { title: "PVC" },
        ru
      )
    );
    expect(body.columns[1]).toBe(translate("ru", "columns", "accessModes"));
    expect(body.columns[1]).not.toBe("Access modes");
  });

  /**
   * A column that cannot say what it draws is not dropped in silence: the
   * reader is told the screen had it and the file does not.
   */
  it("names the columns the file could not carry", () => {
    const delivery: Col = {
      id: "delivery",
      columnDef: { header: columnHeader("columns", "delivery") },
    };
    const section = tableSection(
      tableOf([{ name: "web", delivery: { rendered: true } }], [delivery]),
      { title: "Deployments" },
      t
    );
    expect(tableOfSection(section).columns).toEqual(["Name"]);
    expect(section.caption).toContain(translate("en", "columns", "delivery"));
  });
});

describe("a list that was not read, or not all of it", () => {
  /**
   * Refused outright, the list has no table to register; the file said
   * "Everything this report names was read" under no sections at all.
   */
  it("says why nothing was read instead of drawing an empty table", () => {
    const section = tableSection(
      tableOf([], []),
      { title: "Pods", unread: "No access to list Pods" },
      t
    );
    expect(section.unread).toBe("No access to list Pods");
    expect(section.count).toBeNull();
  });

  /**
   * Two of three namespaces answered. The page drops the total and names
   * the third; the file wrote "Pods 14" as the whole.
   */
  it("draws the rows it has, says what is missing, and gives no total", () => {
    const section = tableSection(
      tableOf([{ name: "a" }, { name: "b" }], []),
      { title: "Pods", partial: "Could not read pods in team-c" },
      t
    );
    expect(section.partial).toBe("Could not read pods in team-c");
    expect(section.count).toBeNull();
    expect(tableOfSection(section).rows).toHaveLength(2);
  });

  /** "Pods 3" under a search for "api" is not three pods in the namespace. */
  it("says the list was searched, and for what", () => {
    const section = tableSection(
      tableOf([{ name: "api-1" }], []),
      { title: "Pods", search: "api" },
      t
    );
    expect(section.caption).toContain("«api»");
  });
});

/** A table as DataTable builds it, from a list's real columns. */
function realTable<Row>(rows: Row[], defs: unknown[]) {
  const cols = (
    defs as {
      id?: string;
      accessorKey?: string;
      accessorFn?: (row: Row) => unknown;
      header?: unknown;
      meta?: unknown;
    }[]
  ).map((def) => ({
    id: def.id ?? String(def.accessorKey),
    columnDef: def,
    read: (row: Row) =>
      def.accessorFn
        ? def.accessorFn(row)
        : def.accessorKey
          ? (row as Record<string, unknown>)[def.accessorKey]
          : undefined,
  }));
  return {
    getVisibleFlatColumns: () => cols,
    getRowModel: () => ({
      rows: rows.map((original) => ({
        original,
        getVisibleCells: () =>
          cols.map((col) => ({
            column: col,
            getValue: () => col.read(original),
          })),
      })),
    }),
  };
}

describe("a list's status, as the list draws it", () => {
  /**
   * A cordoned node keeps `Ready: True`. The list says
   * `Ready,SchedulingDisabled` in amber; the file said `Ready` in green,
   * the one node reader of three that disagreed.
   */
  it("writes a cordoned node as the Nodes list does", () => {
    const node = {
      name: "worker-1",
      roles: [],
      version: "v1.31.0",
      unschedulable: true,
      capacity: null,
      createdAt: null,
      status: {
        ready: true,
        addresses: [],
        conditions: [{ type: "Ready", status: "True" }],
      },
      taints: [],
    };
    const body = tableOfSection(
      tableSection(
        realTable([node], nodeColumns(new Map())),
        { title: "Nodes", kind: "Node" },
        t
      )
    );
    const status = body.rows[0].cells[body.columns.indexOf("Status")];
    expect(status.text).toBe("Ready,SchedulingDisabled");
    expect(status.role).not.toBe("ok");
  });

  /**
   * The Pods list drops the colour of a pod whose node stopped reporting;
   * the file painted it green `Running`.
   */
  it("writes a pod on a node that stopped reporting without colour", () => {
    const pod = {
      name: "web-1",
      namespace: "shop",
      nodeName: "n2",
      podIp: null,
      restartCount: 0,
      lastRestartAt: null,
      createdAt: null,
      containers: [],
      initContainers: [],
      status: { phase: "Running", display: "Running" },
      nodeSilence: { node: "n2", since: null, reason: null },
    };
    const body = tableOfSection(
      tableSection(
        realTable([pod], podColumns),
        { title: "Pods", kind: "Pod" },
        t
      )
    );
    const status = body.rows[0].cells[body.columns.indexOf("Status")];
    expect(status.role).toBe("neutral");
    expect(status.text).toContain("n2");
  });
});
