import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  ApiCatalog,
  CatalogEntry,
  ResourceTable,
  TableRow,
} from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";

const answers = vi.hoisted(() => ({
  catalog: (): Promise<ApiCatalog> =>
    Promise.resolve({ entries: [], unread: [] }),
  pages: [] as Array<string | null>,
  table: (cursor: string | null): Promise<ResourceTable> => {
    void cursor;
    return Promise.reject(new Error("no table"));
  },
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    listApiCatalog: () => answers.catalog(),
    listResourceTable: (
      _group: string,
      _plural: string,
      _scope: string[] | null,
      cursor: string | null
    ) => {
      answers.pages.push(cursor);
      return answers.table(cursor);
    },
  },
}));

const { PrintedList } = await import("./PrintedList");

const LEASES: CatalogEntry = {
  group: "coordination.k8s.io",
  version: "v1",
  kind: "Lease",
  plural: "leases",
  namespaced: true,
  verbs: ["get", "list"],
};

const lease = (name: string): TableRow => ({
  name,
  namespace: "kube-node-lease",
  uid: `uid-${name}`,
  createdAt: null,
  cells: [name, `holder-${name}`],
});

const table = (
  rows: TableRow[],
  cursor: string | null = null
): ResourceTable => ({
  columns: [
    {
      name: "Name",
      columnType: "string",
      format: "name",
      description: "",
      priority: 0,
    },
    {
      name: "Holder",
      columnType: "string",
      format: "",
      description: "",
      priority: 0,
    },
  ],
  rows,
  cursor,
  unread: [],
});

beforeEach(() => {
  answers.pages = [];
  answers.catalog = () => Promise.resolve({ entries: [LEASES], unread: [] });
  useClusterStore.setState({
    currentContext: "test",
    isConnected: true,
    namespaceScope: [],
  });
});

const open = () =>
  renderWithRouter(<PrintedList resource="leases.coordination.k8s.io" />);

describe("a kind listed as the API server prints it", () => {
  /** The server's columns are the list; the name column leads to the object. */
  it("draws the printed cells and links each name to its object", async () => {
    answers.table = () => Promise.resolve(table([lease("node-1")]));
    await open();
    expect(await screen.findByText("holder-node-1")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "node-1" })).toHaveAttribute(
      "href",
      "/c/test/leases.coordination.k8s.io/kube-node-lease/node-1"
    );
  });

  /**
   * A list that stopped at a page boundary is not the whole kind: it says so
   * and reads on from the cursor it was handed.
   */
  it("says there is more and reads on from where the last page stopped", async () => {
    answers.table = (cursor) =>
      Promise.resolve(
        cursor === null
          ? table([lease("node-1")], "after-1")
          : table([lease("node-2")])
      );
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    expect(await screen.findByText("holder-node-2")).toBeInTheDocument();
    expect(answers.pages).toContain("after-1");
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  /** A kind without the list verb would otherwise read as an empty list. */
  it("says a kind that cannot be listed cannot be, rather than that it has none", async () => {
    answers.catalog = () =>
      Promise.resolve({
        entries: [{ ...LEASES, verbs: ["create"] }],
        unread: [],
      });
    await open();
    expect(
      await screen.findByText("leases.coordination.k8s.io cannot be listed")
    ).toBeInTheDocument();
    expect(answers.pages).toEqual([]);
  });
});
