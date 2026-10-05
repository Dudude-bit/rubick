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

import { ResourceList } from "./ResourceList";
import { hrefOf, objectLink } from "@/lib/links";
import { useClusterStore } from "@/stores/clusterStore";
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

  /** Scale opens the dialog the peek opens, seeded with the row's count. */
  it("opens the scale dialog the peek uses", async () => {
    const user = userEvent.setup();
    await draw();
    openMenu();
    await user.click(screen.getByRole("menuitem", { name: "Scale" }));
    expect(await screen.findByRole("spinbutton")).toHaveValue(2);
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
