import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/commands", () => ({
  commands: {
    listApiCatalog: vi.fn(async () => ({
      entries: [
        {
          group: "",
          version: "v1",
          kind: "Pod",
          plural: "pods",
          namespaced: true,
          verbs: ["list"],
        },
        {
          group: "scheduling.k8s.io",
          version: "v1",
          kind: "PriorityClass",
          plural: "priorityclasses",
          namespaced: false,
          verbs: ["list"],
        },
      ],
      unread: [],
    })),
    getRecentItems: vi.fn(async () => []),
    addRecentItem: vi.fn(async () => undefined),
    saveClusterPreferences: vi.fn(async () => undefined),
  },
}));

const search = vi.hoisted(() => ({
  options: {} as { everything?: boolean },
  searched: [] as { kind: string; group: string; plural: string }[],
  loading: [] as { kind: string; group: string; plural: string }[],
  unreadable: [] as {
    kind: string;
    group: string;
    plural: string;
    reason: "forbidden";
    message: string;
  }[],
  hits: [] as {
    context: string;
    kind: string;
    group: string;
    plural: string;
    name: string;
    namespace: string | null;
  }[],
}));

vi.mock("./useResourceSearch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useResourceSearch")>()),
  useResourceSearch: (options: { everything?: boolean }) => {
    search.options = options;
    return {
      hits: search.hits,
      clusters: [
        {
          context: "k3d-dev",
          status: "done",
          reason: null,
          message: null,
          matched: search.hits.length,
          truncated: false,
          searched: search.searched,
          unreadable: search.unreadable,
          loading: search.loading,
        },
      ],
      isSearching: false,
      error: null,
    };
  },
}));

const objectActions = vi.hoisted(() => ({
  run: vi.fn(),
  asked: [] as { kind: string; name: string }[],
}));

vi.mock("../-object/useObjectActions", async () => {
  const { createElement } = await import("react");
  const { RefreshCw, Trash2 } = await import("lucide-react");
  return {
    useObjectActions: (options: { kind: string; name: string }) => {
      objectActions.asked.push(options);
      return {
        plan: {
          inline: [{ id: "restart", label: "Restart", icon: RefreshCw }],
          menu: [{ id: "delete", label: "Delete", icon: Trash2, danger: true }],
        },
        busy: {},
        run: objectActions.run,
        dialogs: createElement(
          "div",
          { "data-testid": "object-dialogs" },
          options.name
        ),
      };
    },
  };
});

vi.mock("../-peek/peek-sources", () => ({
  peekQueryKey: (target: { kind: string; name: string }) => [
    "detail",
    target.kind,
    target.name,
  ],
  resolveSource: () => ({ fetch: async () => ({ ownerReferences: [] }) }),
}));

import { CommandPalette } from "./CommandPalette";
import { renderWithRouter } from "@/test/render";
import { useClusterStore } from "@/stores/clusterStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";

const hit = (over: Partial<(typeof search.hits)[number]> = {}) => ({
  context: "k3d-dev",
  kind: "Pod",
  group: "",
  plural: "pods",
  name: "burst-demo",
  namespace: "k8s-gui-test",
  ...over,
});

async function open(query: string) {
  await renderWithRouter(<CommandPalette />, {
    at: "/c/k3d-dev",
    route: "/c/$cluster/$",
  });
  window.dispatchEvent(new Event("command-palette-open"));
  await userEvent.type(await screen.findByRole("combobox"), query);
}

/**
 * The palette used to build a detail URL for every hit it was handed. A kind
 * the router serves no detail route for — a Namespace — then produced a path
 * that matches no branch inside the layout route, and choosing it blanked the
 * whole shell. A namespace is not a page here; it is the scope pages are read
 * under, which is what the row has to offer instead.
 */
describe("the command palette's hits", () => {
  beforeEach(() => {
    search.hits = [];
    search.unreadable = [];
    search.searched = [{ kind: "Pod", group: "", plural: "pods" }];
    search.loading = [];
    useClusterStore.setState({
      currentContext: "k3d-dev",
      currentNamespace: "",
      isConnected: true,
    });
    useScopeTabStore.setState({
      tabs: [
        {
          id: "palette",
          context: "k3d-dev",
          namespace: "",
          href: "/c/k3d-dev",
          missing: false,
        },
      ],
      activeId: "palette",
      pendingHref: null,
    });
  });

  it("points the window at a namespace instead of opening a page for it", async () => {
    search.hits = [
      hit({
        kind: "Namespace",
        plural: "namespaces",
        name: "kube-system",
        namespace: null,
      }),
    ];
    await open("kube-system");
    await userEvent.click(await screen.findByText("scope to it"));
    expect(useClusterStore.getState().currentNamespace).toBe("kube-system");
    // No second window's worth of tab, and nowhere new: the reader keeps the
    // page they were on, now read under that scope.
    expect(useScopeTabStore.getState().tabs).toHaveLength(1);
  });

  it("opens a namespace in a tab already scoped to it", async () => {
    search.hits = [
      hit({
        kind: "Namespace",
        plural: "namespaces",
        name: "kube-system",
        namespace: null,
      }),
    ];
    await open("kube-system");
    fireEvent.click(await screen.findByText("scope to it"), { ctrlKey: true });
    const { tabs, activeId } = useScopeTabStore.getState();
    expect(tabs).toHaveLength(2);
    expect(tabs[1]).toMatchObject({ namespace: "kube-system" });
    expect(activeId).toBe("palette");
    expect(useClusterStore.getState().currentNamespace).toBe("");
  });

  /**
   * Issue #178: opening a hit in a background tab closed the palette, so a
   * reader wanting three pods open typed the search three times. Would
   * break if the background arm went back to closing.
   */
  it("stays open after opening a hit in a background tab", async () => {
    search.hits = [
      hit({ kind: "Pod", name: "api-web", namespace: "shop" }),
      hit({ kind: "Pod", name: "api-worker", namespace: "shop" }),
    ];
    await open("api");
    fireEvent.click(await screen.findByText(/api-web/), { ctrlKey: true });
    expect(useScopeTabStore.getState().tabs).toHaveLength(2);
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    fireEvent.click(screen.getByText(/api-worker/), { ctrlKey: true });
    expect(useScopeTabStore.getState().tabs).toHaveLength(3);
    expect(useScopeTabStore.getState().activeId).toBe("palette");
  });

  /** The cluster's row said "1 match" in green over a refused Services
   *  list; the unread kinds are part of its answer. */
  it("names the kinds a cluster could not read beside its matches", async () => {
    search.hits = [hit()];
    search.unreadable = [
      {
        kind: "Service",
        group: "",
        plural: "services",
        reason: "forbidden",
        message: "services is forbidden",
      },
    ];
    await open("burst-demo");
    expect(
      await screen.findByText(/could not read Service/)
    ).toBeInTheDocument();
  });

  /** A ServiceAccount named marco was found and then dropped for having no page of its own. */
  it("offers a kind with no page of its own, to open on the generic page", async () => {
    search.hits = [
      hit({
        kind: "ServiceAccount",
        plural: "serviceaccounts",
        name: "marco",
        namespace: "team-checkout",
      }),
    ];
    await open("marco");
    expect(await screen.findByText("marco")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing matches/)).toBeNull();
  });

  /**
   * Marco's Ctrl+K said the refused kinds three times: on the cluster's
   * line, as "13 kinds refused" and again under "no object matches", and
   * the first ran off the dialog mid-word. Fails if they are named twice or
   * the line is not cut with its full list on hover.
   */
  it("names the kinds it could not read once, cut to the row, whole on hover", async () => {
    const refused = [
      "DaemonSet",
      "PodDisruptionBudget",
      "NetworkPolicy",
      "Role",
      "RoleBinding",
      "ClusterRole",
      "ClusterRoleBinding",
    ];
    search.unreadable = refused.map((kind) => ({
      kind,
      group: "",
      plural: `${kind.toLowerCase()}s`,
      reason: "forbidden",
      message: `${kind.toLowerCase()}s is forbidden`,
    }));
    await open("access");
    const line = await screen.findByText(/could not read DaemonSet/);
    expect(line).toHaveClass("truncate");
    expect(line).toHaveAttribute(
      "title",
      refused
        .map((kind) => `${kind}: ${kind.toLowerCase()}s is forbidden`)
        .join("\n")
    );
    expect(document.body.textContent?.split("PodDisruptionBudget").length).toBe(
      2
    );
    expect(screen.queryByText(/kinds? refused/)).toBeNull();
  });

  /**
   * The refused kinds and the ones still loading are the two parts of the
   * answer a reader must not mistake for "none": each wears its own tone.
   */
  it("draws refused kinds in the warning tone and loading ones as loading", async () => {
    search.unreadable = [
      {
        kind: "ServiceAccount",
        group: "",
        plural: "serviceaccounts",
        reason: "forbidden",
        message: "serviceaccounts is forbidden",
      },
    ];
    search.loading = [
      { kind: "Widget", group: "demo.example.com", plural: "widgets" },
    ];
    await open("marco");
    const refused = await screen.findByText(/could not read ServiceAccount/);
    expect(refused.parentElement).toHaveClass("text-warn");
    expect(refused).toHaveAttribute(
      "title",
      "ServiceAccount: serviceaccounts is forbidden"
    );
    expect(
      screen.getByText("1 kind still loading").closest("span")
    ).toHaveClass("text-info");
    expect(screen.getByText("Names searched in 1 kind")).toBeInTheDocument();
  });

  /**
   * The kinds left out are one Enter away: the row asks for every kind the
   * cluster serves, and the request is what changes.
   */
  it("searches every served kind once the reader asks for the rest", async () => {
    await open("marco");
    expect(search.options.everything).toBe(false);
    await userEvent.click(await screen.findByText("Search 1 more kind too"));
    expect(search.options.everything).toBe(true);
    expect(screen.queryByText(/Search 1 more kind/)).toBeNull();
  });

  it("still opens the kinds it does have a page for", async () => {
    search.hits = [hit()];
    await open("burst-demo");
    expect(await screen.findByText(/burst-demo/)).toBeInTheDocument();
  });
});

/**
 * Dana's k9s habit had no home: the palette was object search only. A hit's
 * actions and the page's own object's are the object menu's registry, run
 * through the very hook and dialogs the peek uses.
 */
describe("the command palette's object actions", () => {
  beforeEach(() => {
    search.hits = [];
    search.unreadable = [];
    search.searched = [{ kind: "Pod", group: "", plural: "pods" }];
    search.loading = [];
    objectActions.run.mockClear();
    objectActions.asked = [];
    useClusterStore.setState({
      currentContext: "k3d-dev",
      currentNamespace: "",
      isConnected: true,
    });
  });

  /** Tab opens a hit's actions; Escape gives the search back as it was. */
  it("opens a highlighted hit's actions with Tab and goes back with Escape", async () => {
    search.hits = [hit()];
    await open("burst");
    await screen.findByText("burst-demo");
    await userEvent.keyboard("{Tab}");
    expect(await screen.findByText("Restart")).toBeInTheDocument();
    expect(screen.getByText("Copy name")).toBeInTheDocument();
    expect(objectActions.asked.at(-1)).toMatchObject({
      kind: "Pod",
      name: "burst-demo",
    });

    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("combobox")).toHaveValue("burst");
    expect(screen.queryByText("Restart")).toBeNull();
    expect(screen.getByText("burst-demo")).toBeInTheDocument();
  });

  /**
   * An action runs through the registry and its dialog outlives the
   * palette: closing the palette must not take the confirmation with it.
   */
  it("runs a registry action through the object menu's hook and keeps its dialog", async () => {
    search.hits = [hit()];
    await open("burst");
    await screen.findByText("burst-demo");
    await userEvent.keyboard("{Tab}");
    await screen.findByText("Delete");
    await userEvent.keyboard("del{Enter}");

    expect(objectActions.run).toHaveBeenCalledWith("delete");
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByTestId("object-dialogs")).toHaveTextContent(
      "burst-demo"
    );
  });

  /** On an object's page its own actions are one word away. */
  it("offers the page's own object, and finds its action by name", async () => {
    await renderWithRouter(<CommandPalette />, {
      at: "/c/k3d-dev/pods/shop/burst-demo",
      route: "/c/$cluster/pods/$namespace/$name",
    });
    window.dispatchEvent(new Event("command-palette-open"));
    expect(await screen.findByText("Actions on")).toBeInTheDocument();

    await userEvent.type(screen.getByRole("combobox"), "restart");
    expect(await screen.findByText("This object")).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    expect(objectActions.run).toHaveBeenCalledWith("restart");
  });
});
