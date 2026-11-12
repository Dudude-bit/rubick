import { describe, expect, it, vi } from "vite-plus/test";
import { fireEvent, screen } from "@testing-library/react";

vi.mock("../-delivery/useDelivery", async (original) => ({
  ...(await original<typeof import("../-delivery/useDelivery")>()),
  useDeliveries: () => ({
    available: true,
    of: () => [],
    isPending: false,
    error: null,
  }),
}));

import {
  ScreenShareProvider,
  useScreenSections,
} from "@/components/share/screen-share";
import type { ColumnDef } from "@/components/ui/table-features";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";
import { ResourceList } from "./ResourceList";

interface Item {
  name: string;
  namespace: string;
}
const columns: ColumnDef<Item>[] = [{ accessorKey: "name", header: "Name" }];

/**
 * The delivery filter is the list's own state, in neither the address nor
 * the rows: with "Not delivered" pressed the shared file listed four of
 * forty Deployments as "Deployments 4". Fails if the list stops telling
 * Share which answer of the filter its rows are.
 */
describe("a list narrowed by its delivery filter, in what it hands Share", () => {
  it("says which answer the rows are, and nothing while every row is drawn", async () => {
    useClusterStore.setState({ isConnected: true, currentContext: "prod" });
    let collect: ReturnType<typeof useScreenSections> = null;
    function Probe() {
      collect = useScreenSections();
      return null;
    }
    await renderWithRouter(
      <ScreenShareProvider>
        <ResourceList<Item>
          title="Deployments"
          kind="Deployment"
          columns={columns}
          emptyStateLabel="Deployments"
          delivery={{ group: "apps", kind: "Deployment" }}
          data={[{ name: "web", namespace: "shop" }]}
        />
        <Probe />
      </ScreenShareProvider>,
      { at: "/c/prod/deployments", route: "/c/$cluster/$" }
    );
    expect(collect!()[0].caption).not.toContain("Only the rows");

    fireEvent.click(screen.getByRole("button", { name: "Not delivered" }));
    expect(collect!()[0].caption).toContain(
      "Only the rows whose delivery is: Not delivered."
    );
  });
});

describe("a list a link narrowed to named rows, under its delivery filter", () => {
  /**
   * The Delivery filter hides rows that are in the list. Fails if a named
   * row it hides is counted among the ones "not in this list now".
   */
  it("does not call a named row the filter hides gone", async () => {
    useClusterStore.setState({ isConnected: true, currentContext: "prod" });
    await renderWithRouter(
      <ResourceList<Item>
        title="Deployments"
        kind="Deployment"
        columns={columns}
        emptyStateLabel="Deployments"
        delivery={{ group: "apps", kind: "Deployment" }}
        data={[{ name: "web", namespace: "shop" }]}
      />,
      { at: "/c/prod/deployments?names=shop%2Fweb", route: "/c/$cluster/$" }
    );
    expect(screen.getByText("web")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Needs attention" }));
    expect(screen.queryByText("web")).toBeNull();
    expect(screen.queryByText(/not in this list now/)).toBeNull();
    expect(screen.queryByText(/not among the rows/)).toBeNull();
  });
});
