import { describe, expect, it, vi } from "vite-plus/test";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { queryKeys } from "@/lib/query-keys";

type Heard = (event: { payload: { changed: string[] } }) => void;
const heard = new Set<Heard>();

vi.mock("@/lib/events", () => ({
  listenEvent: (_channel: string, handler: Heard) => {
    heard.add(handler);
    return Promise.resolve(() => heard.delete(handler));
  },
}));

vi.mock("@/stores/clusterStore", () => ({
  useClusterStore: {
    getState: () => ({ entriesChanged: () => Promise.resolve() }),
  },
}));

const { useWatchForKubeconfig } = await import("./useWatchForKubeconfig");

describe("the kubeconfig watcher in the window", () => {
  /**
   * The source line in Settings and at the front door reads the key the
   * watcher invalidates. Fails if the two are spelled apart, which leaves
   * that line naming the file before the change.
   */
  it("reads again the kubeconfig source the settings line shows", async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.kubeconfigSource(), { path: "/old" });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    renderHook(() => useWatchForKubeconfig(), { wrapper });
    await vi.waitFor(() => expect(heard.size).toBe(1));
    for (const handler of heard) handler({ payload: { changed: ["prod"] } });
    expect(
      client.getQueryState(queryKeys.kubeconfigSource())?.isInvalidated
    ).toBe(true);
  });
});
