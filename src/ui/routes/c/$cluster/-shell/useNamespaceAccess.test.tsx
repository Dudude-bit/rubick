import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";

import type { NamespaceAccess } from "@/generated/types";
import { credentialsRenewed } from "@/lib/credentials";
import { useClusterStore } from "@/stores/clusterStore";
import { testQueryClient } from "@/test/render";

const checkNamespaceAccess = vi.hoisted(() =>
  vi.fn<(names: string[]) => Promise<NamespaceAccess[]>>()
);
vi.mock("@/lib/commands", () => ({ commands: { checkNamespaceAccess } }));

const { useNamespaceAccess } = await import("./useNamespaceAccess");

describe("the namespaces the picker hides as shut", () => {
  /**
   * A renewal asks about every namespace again. With the last answer let go
   * meanwhile, each namespace hidden because nothing in it may be listed
   * came back into the picker every quarter of an hour, until the review
   * answered. Fails if a shut namespace is offered while the same cluster
   * is asked again, or if one cluster's answer is held for another.
   */
  it("stay hidden while the same cluster is asked again after a renewal", async () => {
    useClusterStore.setState({ isConnected: true, currentContext: "prod" });
    checkNamespaceAccess.mockResolvedValue([
      { namespace: "kube-system", allowed: false, otherLists: false },
      { namespace: "shop", allowed: true, otherLists: true },
    ]);
    const client = testQueryClient();
    const { result } = renderHook(
      () => useNamespaceAccess(["shop", "kube-system"]),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      }
    );
    await waitFor(() =>
      expect([...result.current.shut]).toEqual(["kube-system"])
    );

    checkNamespaceAccess.mockImplementation(() => new Promise(() => {}));
    act(() => credentialsRenewed());
    await waitFor(() => expect(checkNamespaceAccess).toHaveBeenCalledTimes(2));
    expect([...result.current.shut]).toEqual(["kube-system"]);

    act(() => useClusterStore.setState({ currentContext: "staging" }));
    expect([...result.current.shut]).toEqual([]);
  });
});
