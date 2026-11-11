import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/lib/commands", () => ({
  commands: {
    getKubeconfigPath: vi.fn(async () => null),
    getKubeconfigPaths: vi.fn(async () => []),
    getKubeconfigSource: vi.fn(async () => ({ candidates: [] })),
    setKubeconfigPaths: vi.fn(async () => undefined),
    clearKubeconfigPath: vi.fn(async () => undefined),
    listContexts: vi.fn(async () => [{ name: "acme-staging" }]),
    getCurrentContext: vi.fn(async () => "acme-staging"),
    getClusterPreferences: vi.fn(async () => ({
      lastContext: null,
      namespaces: {},
      scopes: {},
    })),
    connectCluster: vi.fn(async (context: string) => ({ context })),
    disconnectCluster: vi.fn(async () => undefined),
    focusCluster: vi.fn(async () => null),
    releaseClusters: vi.fn(async () => []),
    saveClusterPreferences: vi.fn(async () => undefined),
  },
}));

vi.mock("@/lib/host", () => ({ pickPath: vi.fn(async () => null) }));

vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { commands } from "@/lib/commands";
import { testQueryClient } from "@/test/render";
import { useClusterStore } from "@/stores/clusterStore";
import type { ContextInfo } from "@/generated/types";
import { useKubeconfigPath } from "./useKubeconfigPath";

function mount() {
  const client = testQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useKubeconfigPath(), { wrapper });
}

const cluster = () => useClusterStore.getState();

describe("changing the kubeconfig files while connected", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useClusterStore.setState({
      contexts: [{ name: "acme-staging" } as ContextInfo],
      currentContext: "acme-staging",
      isConnected: true,
      pendingContext: null,
      isAuthenticating: false,
      live: ["acme-staging"],
    });
  });

  /**
   * The backend lets go of every client when the files change. Fails if the
   * window is not connected again to the cluster it shows: it went on
   * saying connected while every read answered "No cluster connected".
   */
  it("connects the cluster on screen again after a file is added", async () => {
    const { result } = mount();

    act(() => result.current.setPaths(["/home/dana/work", "/home/dana/home"]));

    await waitFor(() =>
      expect(commands.connectCluster).toHaveBeenCalledWith("acme-staging")
    );
    expect(commands.setKubeconfigPaths).toHaveBeenCalledBefore(
      vi.mocked(commands.connectCluster)
    );
    await waitFor(() => expect(cluster().isConnected).toBe(true));
  });

  /**
   * Decided on the list the new files gave, not the one on screen before.
   * Fails if a cluster the new files do not name is connected to, or kept.
   */
  it("leaves a cluster that going back to the default lookup dropped", async () => {
    vi.mocked(commands.listContexts).mockResolvedValueOnce([
      { name: "home-lab" } as ContextInfo,
    ]);
    const { result } = mount();

    act(() => result.current.clearPath());

    await waitFor(() => expect(cluster().isConnected).toBe(false));
    expect(cluster().currentContext).toBeNull();
    expect(commands.connectCluster).not.toHaveBeenCalled();
  });

  /**
   * Reading the same files again drops nothing in the backend. Fails if a
   * reload costs the reader the session they have.
   */
  it("keeps the session when the files are only read again", async () => {
    const { result } = mount();

    await act(() => result.current.reload());

    expect(commands.listContexts).toHaveBeenCalled();
    expect(commands.connectCluster).not.toHaveBeenCalled();
    expect(cluster().isConnected).toBe(true);
  });
});
