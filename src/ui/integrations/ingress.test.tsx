import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { ServiceBacking, ServiceInfo } from "@/generated/types";

const listServiceBacking =
  vi.fn<(namespace: string | null) => Promise<ServiceBacking>>();
const store = vi.hoisted(() => ({
  state: { currentContext: "prod", namespaceScope: ["team"] as string[] },
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    listServiceBacking: (namespace: string | null) =>
      listServiceBacking(namespace),
  },
}));
vi.mock("@/stores/clusterStore", () => ({
  useClusterStore: <T,>(selector: (s: typeof store.state) => T) =>
    selector(store.state),
}));

const { backingFrom, backingOf, useBackingLists } = await import("./ingress");

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const service = (name: string, namespace: string) =>
  ({ name, namespace }) as ServiceInfo;

const refusal = {
  code: "PERMISSION_DENIED",
  message: "services is forbidden at the cluster scope",
};

describe("the Services behind a routing page", () => {
  /**
   * A reader bound to their namespaces was refused the cluster's Services,
   * and every backend read as unread while their own were theirs to read.
   * Fails if a refused cluster read is not followed by the window's
   * namespaces, or if a namespace it did not read is judged.
   */
  it("reads the window's namespaces where the cluster refuses, and judges only those", async () => {
    listServiceBacking.mockImplementation(async (namespace) => {
      if (namespace === null) throw refusal;
      return {
        services: [service("api", namespace)],
        published: [],
        readAt: "2026-10-16T03:00:00Z",
      };
    });

    const { result } = renderHook(() => useBackingLists(), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(listServiceBacking).toHaveBeenCalledWith("team");
    const sources = backingFrom(result.current.data, result.current.error);
    expect(sources).toMatchObject({
      backingKnown: false,
      readIn: ["team"],
      backingError: "services is forbidden at the cluster scope",
    });
    const from = { kind: "HTTPRoute", name: "web", namespace: "team" };
    expect(
      backingOf({ name: "api", namespace: "team" }, from, sources).known
    ).toBe(true);
    expect(
      backingOf({ name: "api", namespace: "other" }, from, sources)
    ).toMatchObject({
      known: false,
      error: "services is forbidden at the cluster scope",
    });
  });
});
