/**
 * What the list says when the read did not work.
 *
 * "The scope holds none of these" and "the app could not find out" are
 * different sentences with different fixes, and the table's empty state is
 * only ever entitled to the first one.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";

import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/stores/clusterStore", () => {
  const state = {
    currentNamespace: "default",
    namespaceScope: [] as string[],
    isConnected: true,
  };
  return {
    useClusterStore: vi.fn(<T,>(selector?: (s: typeof state) => T) =>
      typeof selector === "function" ? selector(state) : state
    ),
  };
});

import { ResourceList } from "./ResourceList";

interface Item {
  name: string;
  namespace: string;
}

const columns: ColumnDef<Item>[] = [{ accessorKey: "name", header: "Name" }];

const list = (props: { data: Item[]; error?: Error | null }) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={["/pods"]}>
        <TooltipProvider>
          <ResourceList<Item>
            title="Pods"
            columns={columns}
            emptyStateLabel="Pods"
            {...props}
          />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );

describe("a list whose rows come from outside", () => {
  /**
   * The regression this exists for. A page that fetches its own rows — one
   * with `usePodsWithMetrics` behind it, or a workload list — hands
   * `ResourceList` an array either way, so a scope the token cannot read and a
   * scope with nothing in it arrived here identical. Every such page told the
   * reader their cluster had no pods.
   */
  it("says the read failed rather than that the scope is empty", () => {
    list({ data: [], error: new Error("connection reset by peer") });

    expect(screen.getByText(/Could not read Pods in this scope/)).toBeVisible();
    expect(screen.getByText(/connection reset/)).toBeVisible();
  });

  /**
   * A refusal is not a failure. "Could not read" describes something broken
   * and invites a retry that will be refused in exactly the same way, which
   * is how an ordinary RBAC boundary came to read as a fault in the app.
   */
  it("says a refusal is a refusal", () => {
    list({ data: [], error: new Error("pods is forbidden: RBAC") });

    expect(
      screen.getByText(/do not have permission to list these/)
    ).toBeVisible();
    expect(screen.queryByText(/Could not read/)).not.toBeInTheDocument();
    // The cluster's own words stay: they name the resource and the user,
    // which is what somebody takes to whoever grants the rights.
    expect(screen.getByText(/forbidden/)).toBeVisible();
  });

  /** No error, no rows: the scope really is empty, and says so. */
  it("draws the empty state when nothing failed", () => {
    list({ data: [] });

    expect(screen.queryByText(/Could not read/)).not.toBeInTheDocument();
    expect(screen.getByText(/No resources of this type/)).toBeVisible();
  });

  /**
   * The same rule the internal query already followed: a failed re-read over
   * rows that are still on screen is not worth throwing the page away for.
   */
  it("keeps the rows it has when a re-read fails", () => {
    list({
      data: [{ name: "api-7bcd", namespace: "default" }],
      error: new Error("connection reset"),
    });

    expect(screen.getByText("api-7bcd")).toBeVisible();
    expect(screen.queryByText(/Could not read/)).not.toBeInTheDocument();
  });
});
