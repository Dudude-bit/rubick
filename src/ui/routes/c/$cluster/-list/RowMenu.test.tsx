import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Eye, Trash2 } from "lucide-react";
import type { ColumnDef } from "@/components/ui/table-features";
import type { ObjectRef, ResourceConnections } from "@/generated/types";

const getStatefulset = vi.hoisted(() => vi.fn());
const getDeployment = vi.hoisted(() => vi.fn());
const getResourceConnections = vi.hoisted(() => vi.fn());
const restartDeployment = vi.hoisted(() => vi.fn());
vi.mock("@/lib/commands", async (original) => {
  const real = await original<typeof import("@/lib/commands")>();
  return {
    commands: {
      ...real.commands,
      getStatefulset,
      getDeployment,
      getResourceConnections,
      restartDeployment,
    },
  };
});

import { ResourceList } from "./ResourceList";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { hrefOf, objectLink } from "@/lib/links";
import { RESOURCE_REGISTRY } from "@/lib/resource-registry";
import { planPeekActions } from "../-peek/peek-actions";
import { useClusterStore } from "@/stores/clusterStore";
import { useClusterIdentityStore } from "@/stores/clusterIdentityStore";
import { renderWithRouter } from "@/test/render";

interface Deployment {
  name: string;
  namespace: string;
  replicas: { desired: number; ready: number; available: number };
}

const WEB: Deployment = {
  name: "web",
  namespace: "shop",
  replicas: { desired: 2, ready: 2, available: 2 },
};

const columns: ColumnDef<Deployment>[] = [
  {
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) => <span data-testid="cell">{row.original.name}</span>,
  },
];

const ref = (kind: string, facts: ObjectRef["facts"]): ObjectRef => ({
  kind,
  name: "web",
  namespace: "shop",
  existence: "present",
  facts,
});

const governedByAutoscaler: ResourceConnections = {
  subject: ref("Deployment", null),
  edges: [
    {
      from: ref("HorizontalPodAutoscaler", {
        kind: "autoscaler",
        minReplicas: 2,
        maxReplicas: 5,
        currentReplicas: 2,
        desiredReplicas: 2,
        metrics: [],
        conditions: [],
        lastScaleTime: null,
      }),
      to: ref("Deployment", null),
      relation: { verb: "governs", selector: null },
    },
  ],
  stops: [],
  published: [],
  notLookedAt: [],
};

const listDelete = vi.fn();

const draw = () =>
  renderWithRouter(
    <ResourceList<Deployment>
      title="Deployments"
      emptyStateLabel="deployments"
      data={[WEB]}
      columns={columns}
      getRowHref={(row) => hrefOf(objectLink({ kind: "Deployment", ...row })!)}
      quickActions={[
        { icon: Eye, label: "View details", onClick: vi.fn() },
        {
          icon: Trash2,
          label: "Delete",
          onClick: listDelete,
          variant: "destructive",
        },
      ]}
    />,
    { at: "/c/prod/deployments", route: "/c/$cluster/$" }
  );

const openMenu = () =>
  fireEvent.contextMenu(screen.getByTestId("cell"), {
    clientX: 30,
    clientY: 40,
  });

const items = () =>
  screen.getAllByRole("menuitem").map((item) => item.textContent);

beforeEach(() => {
  useClusterStore.setState({ isConnected: true, namespaceScope: [] });
});

afterEach(() => {
  listDelete.mockReset();
  getDeployment.mockReset();
  getStatefulset.mockReset();
  getResourceConnections.mockReset();
  restartDeployment.mockReset();
});

describe("a list row's right-click menu", () => {
  /** Lens offers these on a row; the webview offered Back and Reload. */
  it("opens the row, copies what a terminal needs, and offers the row's actions", async () => {
    await draw();
    openMenu();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(items()).toEqual([
      "Open",
      "Open in side panelEnter",
      "Open in a new tab",
      "Copy name",
      "Copy name with namespace",
      "Copy kubectl get command",
      "Copy link",
      "Scale",
      "Restart",
      "Tell me when the rollout finishes",
      "Delete",
    ]);
  });

  /**
   * Destructive last, in the danger tone, behind a separator; and only once,
   * though the list has its own Delete button under the same name.
   */
  it("puts Delete last, red, and alone", async () => {
    await draw();
    openMenu();
    const menu = screen.getByRole("menu");
    const deletes = within(menu).getAllByRole("menuitem", { name: /Delete/ });
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toHaveClass("text-err");
    const last = within(menu).getAllByRole("menuitem").at(-1);
    expect(last).toBe(deletes[0]);
    expect(
      deletes[0].parentElement?.previousElementSibling?.getAttribute("role")
    ).toBe("separator");
  });

  /** Delete asks with the same typed-name dialog the peek and the page use. */
  it("asks before deleting, by the object's name", async () => {
    const user = userEvent.setup();
    await draw();
    openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(listDelete).not.toHaveBeenCalled();
  });

  /** Scale opens the dialog the peek opens, seeded with the object's count. */
  it("opens the scale dialog the peek uses", async () => {
    getDeployment.mockResolvedValue({ ...WEB, generation: 1 });
    const user = userEvent.setup();
    await draw();
    openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Scale" }));
    expect(await screen.findByRole("spinbutton")).toHaveValue(2);
  });

  /**
   * The row is not the object, so until the Deployment is read its count is
   * not known; seeding 0 made Scale then Enter a scale to zero.
   */
  it("starts the scale field empty, and holds Scale, while the count is unread", async () => {
    getDeployment.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    await draw();
    openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Scale" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("spinbutton")).toHaveValue(null);
    expect(
      within(dialog).getByText(/current count is not read yet/)
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Scale" })
    ).toBeDisabled();
  });

  /**
   * The menu's trapped focus took the field's focus back while the dialog
   * mounted, and the dialog then focused its first field: minReplicas once
   * the autoscaler was cached, so "3, Enter" asked to change the bounds.
   */
  it("puts the cursor in the replica count on every opening, the autoscaler cached or not", async () => {
    getDeployment.mockResolvedValue({ ...WEB, generation: 1 });
    getResourceConnections.mockResolvedValue(governedByAutoscaler);
    const user = userEvent.setup();
    await draw();
    for (const opening of [1, 2, 3]) {
      openMenu();
      await user.click(screen.getByRole("menuitem", { name: "Scale" }));
      const dialog = await screen.findByRole("dialog");
      await within(dialog).findByLabelText("minReplicas");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(
        within(dialog).getByLabelText("Number of replicas"),
        `opening ${opening}`
      ).toHaveFocus();
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
  });

  /**
   * The neighbourhood read kept the last row's answer while the next row's
   * was in flight, so search's Scale dialog drew cart's autoscaler, and its
   * removal left the focus on the dialog itself.
   */
  it("never shows the previous row's autoscaler in the next row's Scale dialog", async () => {
    const search = { ...WEB, name: "search" };
    let answerSearch: (answer: ResourceConnections) => void = () => {};
    getDeployment.mockImplementation(async (name: string) => ({
      ...(name === "web" ? WEB : search),
      generation: 1,
    }));
    getResourceConnections.mockImplementation((_kind: string, name: string) =>
      name === "web"
        ? Promise.resolve(governedByAutoscaler)
        : new Promise((resolve) => (answerSearch = resolve))
    );
    const user = userEvent.setup();
    await renderWithRouter(
      <ResourceList<Deployment>
        title="Deployments"
        emptyStateLabel="deployments"
        data={[WEB, search]}
        columns={columns}
        getRowHref={(row) =>
          hrefOf(objectLink({ kind: "Deployment", ...row })!)
        }
      />,
      { at: "/c/prod/deployments", route: "/c/$cluster/$" }
    );
    const scaleFrom = async (index: number) => {
      fireEvent.contextMenu(screen.getAllByTestId("cell")[index], {
        clientX: 30,
        clientY: 40,
      });
      await user.click(screen.getByRole("menuitem", { name: "Scale" }));
      return screen.findByRole("dialog");
    };
    const first = await scaleFrom(0);
    await within(first).findByLabelText("minReplicas");
    await user.click(within(first).getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const second = await scaleFrom(1);
    expect(second).toHaveTextContent("Scale Deployment shop/search");
    expect(within(second).queryByLabelText("minReplicas")).toBeNull();
    answerSearch({ ...governedByAutoscaler, edges: [] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(within(second).getByLabelText("Number of replicas")).toHaveFocus();
  });

  /**
   * Dana chose Delete from a row's menu and typed the name: the letters went
   * nowhere and the ring sat on Cancel, because the menu's focus trap took
   * the field's focus back while the dialog mounted. Fails unless every
   * opening puts the cursor in the type-the-name field.
   */
  it("puts the cursor in Delete's type-the-name field on every opening", async () => {
    getDeployment.mockResolvedValue({ ...WEB, generation: 1 });
    const user = userEvent.setup();
    await draw();
    for (const opening of [1, 2]) {
      openMenu();
      await user.click(screen.getByRole("menuitem", { name: /^Delete/ }));
      const dialog = await screen.findByRole("alertdialog");
      await new Promise((resolve) => setTimeout(resolve, 20));
      const field = within(dialog).getByRole("textbox");
      expect(field, `opening ${opening}`).toHaveFocus();
      await user.keyboard("w");
      expect(field).toHaveValue("w");
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await vi.waitFor(() =>
        expect(screen.queryByRole("alertdialog")).toBeNull()
      );
    }
  });

  /**
   * Dana chose Restart from a row's menu and the ring sat on Restart, so a
   * stray Enter would have rolled a Deployment that was 0 of 2 ready. Fails
   * if any opening focuses anything but Cancel, or if Enter restarts.
   */
  it("opens Restart with the cursor on Cancel, so Enter restarts nothing", async () => {
    getDeployment.mockResolvedValue({ ...WEB, generation: 1 });
    const user = userEvent.setup();
    await draw();
    for (const opening of [1, 2]) {
      openMenu();
      await user.click(screen.getByRole("menuitem", { name: /^Restart/ }));
      const dialog = await screen.findByRole("dialog");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(
        within(dialog).getByRole("button", { name: "Cancel" }),
        `opening ${opening}`
      ).toHaveFocus();
      await user.keyboard("{Enter}");
      await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
    expect(restartDeployment).not.toHaveBeenCalled();
  });

  /**
   * On a cluster marked critical a rolling Restart asks for the cluster's
   * name. Fails if the cursor is not in that field, the one the reader must
   * fill, when the dialog opens from the menu.
   */
  it("puts the cursor in the cluster-name field of Restart on a critical cluster", async () => {
    useClusterIdentityStore.getState().setCritical("prod", true);
    useClusterStore.setState({ currentContext: "prod" });
    getDeployment.mockResolvedValue({ ...WEB, generation: 1 });
    const user = userEvent.setup();
    await draw();
    openMenu();
    await user.click(screen.getByRole("menuitem", { name: /^Restart/ }));
    const dialog = await screen.findByRole("dialog");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(within(dialog).getByPlaceholderText("prod")).toHaveFocus();
    useClusterIdentityStore.setState({ marks: {} });
  });

  it("copies the kubectl command that reads this object", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    await draw();
    openMenu();
    await user.click(
      screen.getByRole("menuitem", { name: "Copy kubectl get command" })
    );
    expect(writeText).toHaveBeenCalledWith(
      "kubectl get deployment web -n shop"
    );
  });

  /** Open in side panel is the click's peek; Open is the page. */
  it("opens the peek and the page from their items", async () => {
    const user = userEvent.setup();
    const { router } = await draw();
    openMenu();
    await user.click(
      screen.getByRole("menuitem", { name: /Open in side panel/ })
    );
    await vi.waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        peek: "deployments/shop/web",
      })
    );
    openMenu();
    await user.click(screen.getByRole("menuitem", { name: /^Open$/ }));
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe(
        "/c/prod/deployments/shop/web"
      )
    );
  });
});

describe("a StatefulSet row's delete", () => {
  /**
   * The row is the list's summary, with no claim templates, and the dialog
   * opened from it said they were not read yet while the page's dialog named
   * them: one delete, two readings.
   */
  it("names the claims that stay, as the page's dialog does", async () => {
    getStatefulset.mockResolvedValue({
      name: "orders-db",
      namespace: "shop",
      claimTemplates: ["data"],
      claimsWhenDeleted: "Retain",
      replicas: { desired: 1, ready: 1, current: 1, updated: 1, available: 1 },
    });
    const user = userEvent.setup();
    const row = { ...WEB, name: "orders-db" };
    await renderWithRouter(
      <ResourceList<typeof row>
        title="StatefulSets"
        emptyStateLabel="statefulsets"
        data={[row]}
        columns={[
          {
            accessorKey: "name",
            header: "Name",
            cell: ({ row: r }) => (
              <span data-testid="cell">{r.original.name}</span>
            ),
          },
        ]}
        getRowHref={(r) => hrefOf(objectLink({ kind: "StatefulSet", ...r })!)}
      />,
      { at: "/c/prod/statefulsets", route: "/c/$cluster/$" }
    );
    openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      await within(dialog).findByText(/volumeClaimTemplates \(data\) stay/)
    ).toBeInTheDocument();
    expect(getStatefulset).toHaveBeenCalledWith("orders-db", "shop");
  });
});

const t: T = (section, key, values) => translate("en", section, key, values);

describe("every list kind's row menu", () => {
  /**
   * The menu planned from the list's row as though it were the object, and a
   * row carries only what its list command answered: right-clicking a pod
   * fell over on its containers' ports. A row with nothing but its name must
   * open the same menu the kind's unread object plans.
   */
  it.each(RESOURCE_REGISTRY.map((entry) => [entry.kind, entry] as const))(
    "opens on a bare %s row before the object is read",
    async (_kind, entry) => {
      const row = {
        name: "x",
        namespace: entry.scope === "cluster" ? null : "shop",
      };
      const link = objectLink({ kind: entry.kind, ...row });
      await renderWithRouter(
        <ResourceList<typeof row>
          title={entry.plural}
          emptyStateLabel={entry.plural}
          data={[row]}
          columns={[
            {
              accessorKey: "name",
              header: "Name",
              cell: ({ row: r }) => (
                <span data-testid="cell">{r.original.name}</span>
              ),
            },
          ]}
          getRowHref={link ? () => hrefOf(link) : undefined}
        />,
        { at: `/c/prod/${entry.plural}`, route: "/c/$cluster/$" }
      );
      openMenu();
      const menu = await screen.findByRole("menu");
      const plan = planPeekActions(entry.kind, undefined, t);
      for (const action of [...plan.inline, ...plan.menu]) {
        expect(
          within(menu).getByRole("menuitem", { name: action.label })
        ).toBeInTheDocument();
      }
    }
  );
});
