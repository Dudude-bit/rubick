import { fireEvent, screen } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

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

  /** A bare plural is another group's where the core group lacks it, as kubectl reads it. */
  it("lists a bare plural in the group discovery names", async () => {
    answers.catalog = () =>
      Promise.resolve({
        entries: [{ ...LEASES, group: "coordination.k8s.io" }],
        unread: [],
      });
    answers.table = () => Promise.resolve(table([lease("node-1")]));
    await renderWithRouter(<PrintedList resource="leases" />);
    expect(await screen.findByText("holder-node-1")).toBeInTheDocument();
    expect(screen.queryByText(/serves no/)).toBeNull();
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
  const ROLE_BINDINGS: CatalogEntry = {
    ...LEASES,
    group: "rbac.authorization.k8s.io",
    kind: "RoleBinding",
    plural: "rolebindings",
  };
  const created = new Date(Date.now() - 2 * 3600_000).toISOString();
  const column = (name: string, description = "") => ({
    name,
    columnType: "string",
    format: name === "Name" ? "name" : "",
    description,
    priority: 0,
  });
  // What kube-apiserver's printers declare: Age is a "string" holding kubectl's duration.
  const AGE = column(
    "Age",
    "CreationTimestamp is a timestamp representing the server time when this object was created."
  );
  const row = (name: string, namespace: string, cells: string[]) => ({
    name,
    namespace,
    uid: `uid-${namespace}-${name}`,
    createdAt: created,
    cells,
  });
  const printed = (
    columns: ResourceTable["columns"],
    rows: TableRow[]
  ): ResourceTable => ({ columns, rows, cursor: null, unread: [] });

  async function inRussian(entry: CatalogEntry, answer: ResourceTable) {
    answers.catalog = () => Promise.resolve({ entries: [entry], unread: [] });
    answers.table = () => Promise.resolve(answer);
    useLocaleStore.setState({ choice: "ru" });
    const resource = [entry.plural, entry.group].filter(Boolean).join(".");
    await renderWithRouter(<PrintedList resource={resource} />);
  }

  afterEach(() => useLocaleStore.setState({ choice: null }));

  /**
   * The page was headed by the raw plural, captioned each namespace "1 объект
   * serviceaccounts" under English headers, printed kubectl's "2h0m" and said
   * nothing of what the kind is. Fails if any of those comes back.
   */
  it("is named, counted and explained by its kind, in the reader's language", async () => {
    await inRussian(
      SERVICE_ACCOUNTS,
      printed(
        [column("Name"), AGE],
        [
          row("default", "lena-sandbox", ["default", "2h0m"]),
          row("default", "team-checkout", ["default", "2h0m"]),
        ]
      )
    );
    expect(await screen.findByText("2 объекта ServiceAccount")).toBeVisible();
    expect(screen.getAllByText("· 1 объект ServiceAccount")).toHaveLength(2);
    expect(
      screen.getByRole("heading", { name: "ServiceAccounts" })
    ).toBeVisible();
    expect(screen.getByText(/учётную запись/)).toBeVisible();
    expect(screen.getByText("Подробнее")).toBeVisible();
    expect(screen.getByText("Имя")).toBeVisible();
    expect(screen.getByText("Возраст")).toBeVisible();
    expect(screen.getAllByText("2 ч")).toHaveLength(2);
    expect(screen.queryByText("2h0m")).toBeNull();
    expect(screen.queryByText(/serviceaccounts/)).toBeNull();
  });

  /**
   * RoleBindings printed "Role" in English above a Russian "Имя" and
   * "Возраст", and an empty cell drew a dash where the reader's word belongs.
   */
  it("names the RoleBinding's Role column and an empty cell in the reader's language", async () => {
    await inRussian(
      ROLE_BINDINGS,
      printed(
        [column("Name"), column("Role"), AGE],
        [
          row("demo", "lena-sandbox", ["demo", "Role/demo-reader", "2h0m"]),
          row("orphan", "lena-sandbox", ["orphan", "", "2h0m"]),
        ]
      )
    );
    expect(await screen.findByText("Role/demo-reader")).toBeVisible();
    expect(screen.getByText("Роль")).toBeVisible();
    expect(screen.getAllByText("2 ч")).toHaveLength(2);
    expect(screen.getByText("нет")).toBeVisible();
  });

  /**
   * At 1440 px the Role column cut "Role/system::leader-locking-kube-contr…"
   * beside an Age as wide as itself. Fails if the Role gets no more room
   * than an age, or a cut Role cannot be read whole on hover.
   */
  it("gives a RoleBinding's Role the room an age does not need, and its whole text on hover", async () => {
    const role = "Role/system::leader-locking-kube-controller-manager";
    await inRussian(
      ROLE_BINDINGS,
      printed(
        [column("Name"), column("Role"), AGE],
        [row("leader", "kube-system", ["leader", role, "2h0m"])]
      )
    );
    expect(await screen.findByText(role)).toHaveAttribute("title", role);
    const width = (header: string) =>
      parseFloat(screen.getByText(header).closest("th")!.style.width);
    expect(width("Роль")).toBeGreaterThan(2 * width("Возраст"));
  });
});
