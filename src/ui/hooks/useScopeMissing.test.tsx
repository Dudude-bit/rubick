import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useWindowActivity } from "@/lib/window-activity";
import { useClusterStore } from "@/stores/clusterStore";
import { testQueryClient } from "@/test/render";

const listNamespaces = vi.fn();
vi.mock("@/lib/commands", () => ({
  commands: { listNamespaces: () => listNamespaces() },
}));

const list = vi.hoisted(() => ({
  state: "listed" as "listed" | "refused" | "failed" | "pending",
  data: [] as { name: string }[] | undefined,
}));
vi.mock("@/hooks/useClusterSummary", () => ({
  useNamespaceList: () => ({ ...list, isLoading: false }),
}));

const { useScopeMissing } = await import("./useScopeMissing");

const mount = () => {
  const client = testQueryClient();
  return renderHook(() => useScopeMissing(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
};

beforeEach(() => {
  listNamespaces.mockReset();
  listNamespaces.mockResolvedValue([{ name: "lena-sandbox" }]);
  list.state = "listed";
  list.data = [{ name: "lena-sandbox" }];
  useWindowActivity.setState({ visible: true, focused: true });
  useClusterStore.setState({ isConnected: true, namespaceScope: ["lena"] });
});

describe("which namespaces of the scope the cluster does not have", () => {
  /** Fails if a name the list lacks is not called missing once a fresh list agrees. */
  it("calls a name missing once a list read after it was chosen lacks it too", async () => {
    const { result } = mount();
    expect(result.current).toMatchObject({ missing: [], checking: true });
    await waitFor(() =>
      expect(result.current).toMatchObject({
        missing: ["lena"],
        whole: true,
        checking: false,
      })
    );
  });

  /**
   * A token refused the namespace list cannot tell a namespace that is not
   * there from one it may not see. Fails if a list nobody could read is
   * taken as evidence that a namespace does not exist.
   */
  it("calls nothing missing where the list was refused or failed", async () => {
    for (const state of ["refused", "failed", "pending"] as const) {
      list.state = state;
      list.data = state === "failed" ? [{ name: "lena-sandbox" }] : undefined;
      const { result, unmount } = mount();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(result.current, state).toMatchObject({
        missing: [],
        whole: false,
        checking: false,
      });
      unmount();
    }
    expect(listNamespaces).not.toHaveBeenCalled();
  });

  /** Fails if a scope with a namespace that is there is called wholly missing, or the missing one goes unnamed. */
  it("names only the missing namespace of a scope that holds one that is there", async () => {
    useClusterStore.setState({ namespaceScope: ["lena-sandbox", "lena"] });
    const { result } = mount();
    expect(result.current.checking).toBe(false);
    await waitFor(() =>
      expect(result.current).toMatchObject({ missing: ["lena"], whole: false })
    );
  });
});
