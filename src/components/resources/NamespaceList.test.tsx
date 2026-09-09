import { act, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { DataTable } from "@/components/ui/data-table";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ColumnDef } from "@/components/ui/table-features";
import type { NamespaceInfo } from "@/generated/types";
import { useClusterSummary } from "@/hooks/useClusterSummary";
import { useClusterStore } from "@/stores/clusterStore";
import { NamespaceList } from "./NamespaceList";
import { ResourceList } from "./ResourceList";

vi.mock("@/hooks/useClusterSummary", () => ({ useClusterSummary: vi.fn() }));
vi.mock("@/hooks/useResourceWatch", () => ({
  useResourceWatch: () => ({ resyncing: false }),
}));
vi.mock("./ResourceList", () => ({
  ResourceList: vi.fn(
    ({ columns }: { columns: ColumnDef<NamespaceInfo>[] }) => (
      <DataTable columns={columns} data={namespaces} />
    )
  ),
}));

const namespaces: NamespaceInfo[] = [
  { name: "prod", uid: "prod", status: "Active", labels: {}, createdAt: null },
];

function counts(podCount: number) {
  vi.mocked(useClusterSummary).mockReturnValue({
    namespaces: [{ name: "prod", podCount, problemCount: 0 }],
    podCount,
    problemCount: 0,
    problemsTruncated: 0,
    isLoading: false,
  });
}

const tree = () => (
  <MemoryRouter>
    <TooltipProvider>
      <NamespaceList />
    </TooltipProvider>
  </MemoryRouter>
);

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
it("keeps cell and header component identities while pod counts change", () => {
  const { rerender } = render(tree());
  const before = renderedColumns();
  const renderers = before.map(({ cell, header }) => ({ cell, header }));
  const link = screen.getByRole("link", { name: "Namespace prod" });
  const count = screen.getByText("2");

  counts(7);
  rerender(tree());

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
it("updates the scope marker without remounting the name cell", () => {
  render(tree());
  const link = screen.getByRole("link", { name: "Namespace prod" });
  const nameCell = link.parentElement;
  expect(nameCell).toHaveTextContent("current scope");

  act(() => useClusterStore.setState({ currentNamespace: "staging" }));

  expect(nameCell).not.toHaveTextContent("current scope");
  expect(screen.getByRole("link", { name: "Namespace prod" })).toBe(link);
});
