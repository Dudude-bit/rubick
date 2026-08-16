/**
 * When a failed read is the page, and when it is only a failed read.
 *
 * `ResourceDetailLayout` replaces the whole page for any error it is handed,
 * so what this hook reports as an error decides whether a dropped poll throws
 * away the page the reader is working in.
 */

import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/stores/clusterStore", () => {
  const state = { currentNamespace: "default", isConnected: true };
  return {
    useClusterStore: vi.fn(<T,>(selector?: (s: typeof state) => T) =>
      typeof selector === "function" ? selector(state) : state
    ),
  };
});

// The YAML tab's own read is not what this is about, and it would otherwise
// fire a second unmocked command per render.
vi.mock("./useResourceYaml", () => ({
  useResourceYaml: () => ({
    data: undefined,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { useResourceDetail } from "./useResourceDetail";

interface Pod {
  name: string;
}

const PATH = "/pods/default/api-7bcd";

/** Mounted at a route, because the hook reads the name out of the path. */
function detail(fetchResource: (name: string) => Promise<Pod>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[PATH]}>
        <Routes>
          <Route path="/pods/:namespace/:name" element={<>{children}</>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const rendered = renderHook(
    () =>
      useResourceDetail<Pod>({
        resourceKind: "Pod",
        fetchResource: (name) => fetchResource(name),
        refresh: false,
      }),
    { wrapper }
  );
  return {
    ...rendered,
    /**
     * What the cache thinks, which is not what the page is told — and the
     * whole point. Asserting on the hook alone would pass before the fix too:
     * the mock rejecting is not the same instant as the query settling.
     */
    settled: () => client.getQueryState(["pod", "default", "api-7bcd"]),
  };
}

describe("what a detail page calls an error", () => {
  /**
   * The regression. A poll that failed over an object already on screen — an
   * expiring token, a blip between the app and the API server — replaced the
   * page with "Could not read this pod", and the next poll two seconds later
   * brought it back.
   */
  it("keeps the object when a re-read of it fails", async () => {
    const fetch = vi
      .fn<(name: string) => Promise<Pod>>()
      .mockResolvedValueOnce({ name: "api-7bcd" })
      .mockRejectedValue(new Error("connection reset"));

    const { result, settled } = detail(fetch);
    await waitFor(() => expect(result.current.resource).toBeDefined());

    result.current.refetch();

    await waitFor(() => expect(settled()?.error).not.toBeNull());
    expect(result.current.resource).toEqual({ name: "api-7bcd" });
    expect(result.current.error).toBeNull();
  });

  /** Nothing has ever been read here, so the failure is all there is to say. */
  it("reports a first read that failed", async () => {
    const fetch = vi
      .fn<(name: string) => Promise<Pod>>()
      .mockRejectedValue(new Error("pods 'api-7bcd' is forbidden"));

    const { result } = detail(fetch);

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toMatch(/forbidden/);
  });
});
