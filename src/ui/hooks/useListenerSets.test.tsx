import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const detection = vi.hoisted(() => ({
  data: undefined as { kinds: { kind: string }[] } | undefined,
}));
vi.mock("@/hooks/useGatewayApi", () => ({
  useGatewayApi: () => ({ data: detection.data }),
}));
vi.mock("@/lib/commands", () => ({
  commands: {
    listListenerSets: vi.fn(async () => {
      throw new Error("listenersets is forbidden");
    }),
  },
}));

import { commands } from "@/lib/commands";
import { useListenerSets } from "./useListenerSets";

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

beforeEach(() => {
  vi.mocked(commands.listListenerSets).mockClear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

describe("the ListenerSets a route resolves through", () => {
  /**
   * A route naming a set reads "does not exist" only against a list that
   * was read. Fails if a cluster not yet scanned or one that refused the
   * list gives sets, or one that does not serve the kind is asked or gives
   * anything but none.
   */
  it("are none where the kind is not served, and unread until the list answers", async () => {
    detection.data = undefined;
    const unknown = renderHook(() => useListenerSets(true), { wrapper });
    expect(unknown.result.current).toEqual({ sets: null, said: null });

    detection.data = { kinds: [{ kind: "Gateway" }] };
    const unserved = renderHook(() => useListenerSets(true), { wrapper });
    expect(unserved.result.current).toEqual({ sets: [], said: null });
    expect(commands.listListenerSets).not.toHaveBeenCalled();

    detection.data = { kinds: [{ kind: "Gateway" }, { kind: "ListenerSet" }] };
    const refused = renderHook(() => useListenerSets(true), { wrapper });
    await waitFor(() =>
      expect(refused.result.current.said).toContain("listenersets is forbidden")
    );
    expect(refused.result.current.sets).toBeNull();
  });
});
