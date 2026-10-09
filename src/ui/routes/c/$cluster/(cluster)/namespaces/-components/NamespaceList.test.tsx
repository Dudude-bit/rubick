import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { DataTable } from "@/components/ui/data-table";
import type { ColumnDef } from "@/components/ui/table-features";
import type { NamespaceInfo } from "@/generated/types";
import { useClusterSummary } from "@/hooks/useClusterSummary";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";
import { NamespaceList } from "./NamespaceList";
import { ResourceList } from "../../../-list/ResourceList";

vi.mock("@/hooks/useClusterSummary", () => ({ useClusterSummary: vi.fn() }));
vi.mock("@/hooks/useResourceWatch", () => ({
  useResourceWatch: () => ({ resyncing: false }),
}));
vi.mock("../../../-list/ResourceList", () => ({
  ResourceList: vi.fn(
    ({
      columns,
      getRowHref,
    }: {
      columns: ColumnDef<NamespaceInfo>[];
      getRowHref?: (row: NamespaceInfo) => string;
    }) => (
      <DataTable columns={columns} data={namespaces} getRowHref={getRowHref} />
    )
  ),
}));

const namespaces: NamespaceInfo[] = [
  { name: "prod", uid: "prod", status: "Active", labels: {}, createdAt: null },
];

function counts(podCount: number | null) {
  vi.mocked(useClusterSummary).mockReturnValue({
    namespaces: [{ name: "prod", podCount, problems: null }],
    podCount,
    namespaceList: "listed",
    refused: false,
    isLoading: false,
  });
}

const mount = () =>
  renderWithRouter(<NamespaceList />, {
    at: "/c/prod/namespaces",
    route: "/c/$cluster/namespaces",
  });

function renderedColumns() {
  const columns = vi.mocked(ResourceList).mock.calls.at(-1)![0].columns;
  if (!Array.isArray(columns))
    throw new Error("Namespace columns must be an array");
  return columns;
}

beforeEach(() => {
  vi.mocked(ResourceList).mockClear();
  useClusterStore.setState({ currentNamespace: "prod", isConnected: false });
  counts(2);
});

/** Fresh renderer functions remount the cell and replace the link beneath the pointer. */
it("keeps cell and header component identities while pod counts change", async () => {
  const { rerender } = await mount();
  const before = renderedColumns();
  const renderers = before.map(({ cell, header }) => ({ cell, header }));
  const link = screen.getByRole("link", { name: "Namespace prod" });
  const count = screen.getByText("2");

  counts(7);
  await rerender(<NamespaceList />);

  const after = renderedColumns();
  after.forEach((column, index) => {
    expect(column.cell).toBe(renderers[index].cell);
    expect(column.header).toBe(renderers[index].header);
  });
  expect(after).toBe(before);
  expect(screen.getByRole("link", { name: "Namespace prod" })).toBe(link);
  expect(screen.getByText("7")).toBe(count);
});

/** Moving the current-scope value out of the closure must still update its marker. */
it("updates the scope marker without remounting the name cell", async () => {
  await mount();
  const link = screen.getByRole("link", { name: "Namespace prod" });
  const nameCell = link.parentElement;
  expect(nameCell).toHaveTextContent("current scope");

  act(() => useClusterStore.setState({ currentNamespace: "staging" }));

  expect(nameCell).not.toHaveTextContent("current scope");
  expect(screen.getByRole("link", { name: "Namespace prod" })).toBe(link);
});

/**
 * A pod count the overview could not read drew a bare dash, which reads as
 * nothing there. Fails if the unread count says "none" or a glyph, or if a
 * real 0 stops being a number.
 */
it("says an unread pod count is unknown, not none", async () => {
  counts(null);
  await mount();
  expect(screen.getByText("unknown")).toBeInTheDocument();
  expect(screen.queryByText("none")).toBeNull();
  counts(0);
  await mount();
  expect(screen.getByText("0")).toBeInTheDocument();
});

/**
 * The rows had no destination, so a click on the status, the pod count or
 * the space beside the name did nothing. Fails if any of them stops opening
 * the namespace's peek.
 */
it.each(["Active", "2"])(
  "opens the namespace's peek from a click on %s, not only on its name",
  async (cell) => {
    const { router } = await mount();
    await userEvent.click(screen.getByText(cell));
    await vi.waitFor(() =>
      expect(router.state.location.search).toEqual({ peek: "namespaces/prod" })
    );
  }
);
