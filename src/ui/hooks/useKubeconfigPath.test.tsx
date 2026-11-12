import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/lib/commands", () => ({
  commands: {
    getKubeconfigPath: vi.fn(async () => null),
    getKubeconfigPaths: vi.fn(async () => []),
    getKubeconfigSource: vi.fn(async () => ({ candidates: [] })),
    setKubeconfigPath: vi.fn(async () => undefined),
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

const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast }) }));

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

/**
 * Undo read the single-path field, which holds only the first of several
 * pinned files, and for the last file removed it asked for the default
 * lookup: "Kubeconfig restored" over two of three files gone, or over the
 * removed file still missing. Fails if Undo puts back anything but every
 * file that was pinned before the change.
 */
describe("Undo after a kubeconfig change", () => {
  const pinned = ["/home/dana/work", "/home/dana/home", "/home/dana/lab"];

  /** Presses Undo on the toast the change raised. */
  async function undoAfter(
    files: string[],
    change: (hook: ReturnType<typeof useKubeconfigPath>) => void
  ) {
    vi.clearAllMocks();
    vi.mocked(commands.getKubeconfigPath).mockResolvedValue(files[0]);
    vi.mocked(commands.getKubeconfigPaths).mockResolvedValue(files);
    const { result } = mount();
    await waitFor(() => expect(result.current.paths).toEqual(files));

    act(() => change(result.current));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const raised = toast.mock.calls[0][0];
    vi.mocked(commands.setKubeconfigPaths).mockClear();
    vi.mocked(commands.clearKubeconfigPath).mockClear();
    await act(() => raised.action.props.onClick());
    return raised;
  }

  it("pins every file again after going back to the default lookup", async () => {
    await undoAfter(pinned, (hook) => hook.clearPath());
    expect(commands.setKubeconfigPaths).toHaveBeenCalledWith(pinned);
  });

  it("pins every file again after another file replaced them, and says which they were", async () => {
    const raised = await undoAfter(pinned, (hook) =>
      hook.setPath("/home/dana/other")
    );
    expect(raised.description).toContain("/home/dana/lab");
    expect(commands.setKubeconfigPaths).toHaveBeenCalledWith(pinned);
  });

  it("pins the last file again after it was removed", async () => {
    await undoAfter(["/home/dana/work"], (hook) =>
      hook.remove("/home/dana/work")
    );
    expect(commands.setKubeconfigPaths).toHaveBeenCalledWith([
      "/home/dana/work",
    ]);
    expect(commands.clearKubeconfigPath).not.toHaveBeenCalled();
  });
});
