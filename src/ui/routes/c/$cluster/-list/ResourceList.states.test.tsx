import { describe, expect, it, vi } from "vite-plus/test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Trash2 } from "lucide-react";

import type { ColumnDef } from "@/components/ui/table-features";
import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";
import { ResourceList } from "./ResourceList";

interface Item {
  name: string;
  namespace: string;
}
const columns: ColumnDef<Item>[] = [{ accessorKey: "name", header: "Name" }];
const API: Item = { name: "api-1", namespace: "shop" };

const connected = () =>
  useClusterStore.setState({ isConnected: true, currentContext: "prod" });

describe("a list the filters above it narrowed to nothing", () => {
  /** "No resources in the current scope" over rows the ?names= link hid is a false claim about the scope; the sentence must blame the filter and offer to clear it. */
  it("says the filters hide the rows it read, and clears them", async () => {
    connected();
    const user = userEvent.setup();
    const { router } = await renderWithRouter(
      <ResourceList<Item>
        title="Pods"
        kind="Pod"
        columns={columns}
        emptyStateLabel="Pods"
        data={[API]}
      />,
      { at: "/c/prod/pods?names=shop%2Fgone-1", route: "/c/$cluster/$" }
    );
    expect(
      screen.getByText("The rows that were read do not pass the filters above.")
    ).toBeVisible();
    expect(screen.queryByText(/in the current scope/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Clear filter" }));
    await waitFor(() =>
      expect(router.state.location.search).not.toHaveProperty("names")
    );
  });

  /** A list that read nothing at all is not one the filters emptied; blaming them would hide that no rows came back. */
  it("does not blame the filters for a list that read no rows", async () => {
    connected();
    await renderWithRouter(
      <ResourceList<Item>
        title="Pods"
        kind="Pod"
        columns={columns}
        emptyStateLabel="Pods"
        data={[]}
      />,
      { at: "/c/prod/pods?names=shop%2Fgone-1", route: "/c/$cluster/$" }
    );
    expect(screen.queryByText(/do not pass the filters/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear filter" })).toBeNull();
  });
});

describe("the footer of a list that stands in for another read", () => {
  /** "From the namespaces that answered" while the previous scope's rows stand in names namespaces that were never asked. */
  it("says the rows are the previous scope's while the new one is read", async () => {
    connected();
    await renderWithRouter(
      <ResourceList<Item>
        title="Pods"
        kind="Pod"
        columns={columns}
        emptyStateLabel="Pods"
        data={[API]}
        placeholder
      />,
      { at: "/c/prod/pods", route: "/c/$cluster/$" }
    );
    expect(
      screen.getByText(/from the previous scope while this one is read/)
    ).toBeVisible();
    expect(screen.queryByText(/namespaces that answered/)).toBeNull();
  });
});

describe("deleting from a list row", () => {
  const draw = (mutationFn: () => Promise<void>) =>
    renderWithRouter(
      <ResourceList<Item>
        title="Pods"
        kind={null}
        columns={columns}
        emptyStateLabel="Pods"
        data={[API]}
        deleteConfig={{
          mutationFn,
          invalidateQueryKeys: [],
          resourceType: "Pod",
        }}
        quickActions={(requestDelete) => [
          {
            icon: Trash2,
            label: "Delete",
            variant: "destructive",
            onClick: requestDelete,
          },
        ]}
      />,
      { at: "/c/prod/pods", route: "/c/$cluster/$" }
    );

  /** The dialog closed on click while the write was unanswered, so the reader saw no pending state and could ask twice. */
  it("keeps the dialog open and pending until the write answers", async () => {
    connected();
    const user = userEvent.setup();
    let settle!: () => void;
    const write = vi.fn(
      () => new Promise<void>((resolve) => (settle = resolve))
    );
    await draw(write);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    const confirm = within(screen.getByRole("alertdialog")).getByRole(
      "button",
      { name: "Delete" }
    );
    expect(confirm).toBeDisabled();
    expect(confirm.querySelector("svg.animate-spin")).not.toBeNull();
    expect(write).toHaveBeenCalledTimes(1);

    settle();
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    );
  });

  /** A write that failed must leave the dialog up for another try instead of closing as if it had gone through. */
  it("stays open when the write fails", async () => {
    connected();
    const user = userEvent.setup();
    const write = vi.fn(() => Promise.reject(new Error("boom")));
    await draw(write);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        within(screen.getByRole("alertdialog")).getByRole("button", {
          name: "Delete",
        })
      ).toBeEnabled()
    );
  });
});

describe("a list of a namespace the cluster does not have", () => {
  /**
   * In a scope typed as "all", which no namespace is called, a list drew
   * "0" and "none in this scope" beside a sidebar that said not read. Fails
   * if a namespaced list of a wholly missing scope says none, or counts 0.
   */
  it("says the namespace is not there rather than that it holds none", async () => {
    useClusterStore.setState({
      isConnected: true,
      currentContext: "prod",
      namespaceScope: ["all"],
    });
    const listed = vi.spyOn(commands, "listNamespaces").mockResolvedValue([
      {
        name: "argocd",
        uid: "argocd",
        status: "Active",
        labels: {},
        createdAt: null,
      },
    ]);
    try {
      await renderWithRouter(
        <ResourceList<Item>
          title="Rollouts"
          kind={null}
          columns={columns}
          emptyStateLabel="Rollouts"
          data={[]}
        />,
        { at: "/c/prod/rollouts", route: "/c/$cluster/$" }
      );
      expect(
        await screen.findByText(
          "There is no namespace named all in this cluster"
        )
      ).toBeVisible();
      expect(screen.queryByText(/in this scope|current scope/)).toBeNull();
      expect(screen.queryByText("0")).toBeNull();
    } finally {
      listed.mockRestore();
      useClusterStore.setState({ namespaceScope: [] });
    }
  });
});
