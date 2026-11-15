import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@/components/ui/table-features";

const store = vi.hoisted(() => ({
  state: {
    currentNamespace: "default",
    namespaceScope: [] as string[],
    isConnected: true,
    currentContext: null as string | null,
    contexts: [] as Array<{ name: string; namespace: string | null }>,
  },
}));

vi.mock("@/stores/clusterStore", () => ({
  useClusterStore: vi.fn(<T,>(selector?: (s: typeof store.state) => T) =>
    typeof selector === "function" ? selector(store.state) : store.state
  ),
}));

vi.mock("@/lib/commands", async (original) => {
  const real = await original<typeof import("@/lib/commands")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      recheckMetrics: vi.fn(async () => undefined),
      forgetDiscovery: vi.fn(async () => undefined),
    },
  };
});

import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { renderWithRouter } from "@/test/render";
import { MetricsStatusBanner } from "../-metrics";
import { ResourceList } from "./ResourceList";

interface Item {
  name: string;
  namespace: string;
}
const columns: ColumnDef<Item>[] = [{ accessorKey: "name", header: "Name" }];
const silent = { status: "notAnswering" as const, message: null };

beforeEach(() => {
  vi.mocked(commands.recheckMetrics).mockClear();
});

async function stacked(onRetry: () => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData([...queryKeys.metrics.all(), "pods", "all"], {
    status: silent,
  });
  await renderWithRouter(
    <ResourceList<Item>
      title="Deployments"
      kind="Deployment"
      columns={columns}
      emptyStateLabel="Deployments"
      data={[{ name: "api", namespace: "lab" }]}
      error={new Error("etcdserver: request timed out")}
      dataUpdatedAt={Date.now() - 60_000}
      onRetry={onRetry}
      headerContent={<MetricsStatusBanner status={silent} />}
    />,
    { client, at: "/c/prod/deployments", route: "/c/$cluster/$" }
  );
  await screen.findByText(/The metrics API is not answering/);
}

describe("two notices over one list", () => {
  /**
   * The metrics notice and the failed-re-read notice each offered "Try the
   * read again" for reads one press refreshes. Fails if the second button
   * returns, or if the one left stops asking metrics too.
   */
  it("offers one retry that asks the list and metrics again", async () => {
    const onRetry = vi.fn();
    await stacked(onRetry);

    const buttons = screen.getAllByRole("button", {
      name: "Try the read again",
    });
    expect(buttons).toHaveLength(1);
    await userEvent.click(buttons[0]!);
    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(commands.recheckMetrics).toHaveBeenCalledTimes(1)
    );
  });

  /** One inner layout: the list notice puts its cause line and button under the title, as the metrics notice does. */
  it("lays the list notice out as the metrics notice is", async () => {
    await stacked(vi.fn());
    const notice = screen
      .getByText(/Could not read deployments/)
      .closest('[role="status"]') as HTMLElement;
    expect(notice.className).toContain("flex-col");
  });
});

describe("a refused list's keyboard order", () => {
  /** Tab reached "Learn more" before the notice's own buttons. Fails if the kind's docs link sits ahead of the refusal's action again. */
  it("reaches the retry before the docs link", async () => {
    await renderWithRouter(
      <ResourceList<Item>
        title="Pods"
        kind="Pod"
        columns={columns}
        emptyStateLabel="Pods"
        error={Object.assign(
          new Error(
            'pods is forbidden: User "<redacted>" cannot list resource "pods"'
          ),
          { code: "PERMISSION_DENIED" }
        )}
        onRetry={() => undefined}
      />,
      { at: "/c/prod/pods", route: "/c/$cluster/$" }
    );
    const retry = await screen.findByRole("button", {
      name: "Try the read again",
    });
    const learn = screen.getByText("Learn more");
    expect(
      retry.compareDocumentPosition(learn) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});
