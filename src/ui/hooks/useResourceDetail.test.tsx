/**
 * When a failed read is the page, and when it is only a failed read.
 *
 * `ResourceDetailLayout` replaces the whole page for any error it is handed,
 * so what this hook reports as an error decides whether a dropped poll throws
 * away the page the reader is working in.
 */

import { describe, expect, it, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";

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

import { queryKeys } from "@/lib/query-keys";
import { renderWithRouter, testQueryClient } from "@/test/render";
import {
  useResourceDetail,
  type UseResourceDetailResult,
} from "./useResourceDetail";

interface Pod {
  name: string;
}

const PATH = "/c/prod/pods/default/api-7bcd";

/** Mounted at a route, because the hook reads the name out of the path. */
async function detail(fetchResource: (name: string) => Promise<Pod>) {
  const client = testQueryClient();
  const result = {} as { current: UseResourceDetailResult<Pod> };
  function Probe() {
    result.current = useResourceDetail<Pod>({
      resourceKind: "Pod",
      fetchResource: (name) => fetchResource(name),
      refresh: false,
    });
    return null;
  }
  const { router } = await renderWithRouter(<Probe />, {
    client,
    at: PATH,
    route: "/c/$cluster/pods/$namespace/$name",
  });
  return {
    result,
    router,
    /**
     * What the cache thinks, which is not what the page is told — and the
     * whole point. Asserting on the hook alone would pass before the fix too:
     * the mock rejecting is not the same instant as the query settling.
     */
    settled: () =>
      client.getQueryState(queryKeys.detail("Pod", "default", "api-7bcd")),
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

    const { result, settled } = await detail(fetch);
    await waitFor(() => expect(result.current.resource).toBeDefined());

    result.current.refetch();

    await waitFor(() => expect(settled()?.error).not.toBeNull());
    expect(result.current.resource).toEqual({ name: "api-7bcd" });
    expect(result.current.error).toBeNull();
  });

  /**
   * The peek, the events timeline and a pod's node placement read this entry
   * rather than asking again, and every mutation invalidates it by the same
   * builder. Fails if the page keys its object anywhere else.
   */
  it("keeps the object where every other reader of it looks", async () => {
    const fetch = vi
      .fn<(name: string) => Promise<Pod>>()
      .mockResolvedValue({ name: "api-7bcd" });

    const { result, settled } = await detail(fetch);
    await waitFor(() => expect(result.current.resource).toBeDefined());
    expect(settled()?.data).toEqual({ name: "api-7bcd" });
  });

  /** Nothing has ever been read here, so the failure is all there is to say. */
  it("reports a first read that failed", async () => {
    const fetch = vi
      .fn<(name: string) => Promise<Pod>>()
      .mockRejectedValue(new Error("pods 'api-7bcd' is forbidden"));

    const { result } = await detail(fetch);

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toMatch(/forbidden/);
  });
});

describe("the tab a detail page is open on", () => {
  /**
   * A copied address, a deep link or a scope tab restored next launch has
   * only the address to go on. Fails if the tab is kept in the page alone.
   */
  it("is written into the address, and the default tab is left out", async () => {
    const fetch = vi
      .fn<(name: string) => Promise<Pod>>()
      .mockResolvedValue({ name: "api-7bcd" });
    const { result, router } = await detail(fetch);
    expect(result.current.activeTab).toBe("overview");

    act(() => result.current.setActiveTab("logs"));
    await waitFor(() =>
      expect(router.state.location.href).toBe(`${PATH}?tab=logs`)
    );
    await waitFor(() => expect(result.current.activeTab).toBe("logs"));

    act(() => result.current.setActiveTab("overview"));
    await waitFor(() => expect(router.state.location.href).toBe(PATH));
    await waitFor(() => expect(result.current.activeTab).toBe("overview"));
  });
});
