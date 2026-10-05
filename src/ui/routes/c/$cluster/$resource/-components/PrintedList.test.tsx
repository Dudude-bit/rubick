import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  ApiCatalog,
  CatalogEntry,
  ResourceTable,
  TableRow,
} from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { useLocaleStore } from "@/stores/localeStore";
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
  shortNames: [],
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

  /**
   * The Access rows lead here, and a namespace-only reader is refused
   * ServiceAccounts cluster-wide. Fails if the refusal draws as no rows, or
   * as no permission at all when a namespace may still list them.
   */
  it("says a list the reader may not read is refused across the cluster, not empty", async () => {
    answers.catalog = () =>
      Promise.resolve({
        entries: [
          {
            ...LEASES,
            group: "",
            kind: "ServiceAccount",
            plural: "serviceaccounts",
          },
        ],
        unread: [],
      });
    answers.table = () =>
      Promise.reject({
        code: "PERMISSION_DENIED",
        message: "serviceaccounts is forbidden",
      });
    await renderWithRouter(<PrintedList resource="serviceaccounts" />);
    expect(
      await screen.findByText(/across the whole cluster was refused/)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Choose a namespace" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/serviceaccounts is forbidden/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/No resources of this type/)).toBeNull();
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

describe("an access kind on the generic list", () => {
  const SERVICE_ACCOUNTS: CatalogEntry = {
    ...LEASES,
    group: "",
    kind: "ServiceAccount",
    plural: "serviceaccounts",
  };
  const created = new Date(Date.now() - 2 * 3600_000).toISOString();
  const accounts: ResourceTable = {
    columns: [
      {
        name: "Name",
        columnType: "string",
        format: "name",
        description: "",
        priority: 0,
      },
      {
        name: "Age",
        columnType: "date",
        format: "",
        description: "",
        priority: 0,
      },
    ],
    rows: [
      {
        name: "default",
        namespace: "lena-sandbox",
        uid: "uid-default",
        createdAt: created,
        cells: ["default", "2h0m"],
      },
    ],
    cursor: null,
    unread: [],
  };

  /**
   * The page was headed by the raw plural, counted "1 объект serviceaccounts"
   * under English headers, printed kubectl's "2h0m" and said nothing of what
   * the kind is. Fails if any of those comes back.
   */
  it("is named, counted and explained by its kind, in the reader's language", async () => {
    answers.catalog = () =>
      Promise.resolve({ entries: [SERVICE_ACCOUNTS], unread: [] });
    answers.table = () => Promise.resolve(accounts);
    useLocaleStore.setState({ choice: "ru" });
    try {
      await renderWithRouter(<PrintedList resource="serviceaccounts" />);
      expect(await screen.findByText("1 объект ServiceAccount")).toBeVisible();
      expect(
        screen.getByRole("heading", { name: "ServiceAccounts" })
      ).toBeVisible();
      expect(screen.getByText(/учётную запись/)).toBeVisible();
      expect(screen.getByText("Подробнее")).toBeVisible();
      expect(screen.getByText("Имя")).toBeVisible();
      expect(screen.getByText("Возраст")).toBeVisible();
      expect(screen.queryByText("2h0m")).toBeNull();
      expect(screen.queryByText("serviceaccounts")).toBeNull();
    } finally {
      useLocaleStore.setState({ choice: null });
    }
  });
});
