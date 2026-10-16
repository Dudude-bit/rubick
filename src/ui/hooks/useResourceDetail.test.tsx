/**
 * When a failed read is the page, and when it is only a failed read.
 *
 * `ResourceDetailLayout` replaces the whole page for any error it is handed,
 * so what this hook reports as an error decides whether a dropped poll throws
 * away the page the reader is working in.
 */

import { describe, expect, it, vi } from "vite-plus/test";
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

const logged = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("@/lib/logger", () => ({
  logError: (message: string) => logged.lines.push(`ERROR ${message}`),
  logWarn: (message: string) => logged.lines.push(`WARN ${message}`),
  logInfo: (message: string) => logged.lines.push(`INFO ${message}`),
  logDebug: () => {},
}));

import { QueryCache, QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { logQueryFailure } from "@/lib/query-log";
import { shareStructure } from "@/lib/watched-rows";
import { renderWithRouter, testQueryClient } from "@/test/render";
import { useLiveQuery } from "./useLiveQuery";
import {
  useResourceDetail,
  type UseResourceDetailResult,
} from "./useResourceDetail";
import { useLastOwners, type Owner } from "./useLastOwners";

interface Pod {
  name: string;
  ownerReferences?: Owner[];
}

const NOT_FOUND = Object.assign(new Error('pods "api-7bcd" not found'), {
  code: "NOT_FOUND",
});

const PATH = "/c/prod/pods/default/api-7bcd";

/** Mounted at a route, because the hook reads the name out of the path. */
async function detail(
  fetchResource: (name: string) => Promise<Pod>,
  client = testQueryClient()
) {
  const result = {} as {
    current: UseResourceDetailResult<Pod>;
    owners: Owner[] | undefined;
  };
  function Probe() {
    result.current = useResourceDetail<Pod>({
      resourceKind: "Pod",
      fetchResource: (name) => fetchResource(name),
      refresh: false,
    });
    result.owners = useLastOwners({
      kind: "Pod",
      name: result.current.name ?? "",
      namespace: result.current.namespace,
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

describe("a detail page whose object is deleted", () => {
  /**
   * NotFound was held back like a dropped poll, so the page drew the deleted
   * pod as live while the peek of it said it was gone.
   */
  it("reports the NotFound over the object it held", async () => {
    const fetch = vi
      .fn<(name: string) => Promise<Pod>>()
      .mockResolvedValueOnce({ name: "api-7bcd" })
      .mockRejectedValue(NOT_FOUND);

    const { result, settled } = await detail(fetch);
    await waitFor(() => expect(result.current.resource).toBeDefined());

    result.current.refetch();

    await waitFor(() => expect(settled()?.error).not.toBeNull());
    expect(result.current.error).toBe(NOT_FOUND);
  });

  /**
   * The object shown while the next one loads is the one before; its owners
   * filed under the new name would point a gone pod at a stranger's
   * ReplicaSet.
   */
  it("files no owners under a name it navigated to from another", async () => {
    const owner = {
      api_version: "apps/v1",
      kind: "ReplicaSet",
      name: "api-7b",
      controller: true,
    };
    const fetch = vi
      .fn<(name: string) => Promise<Pod>>()
      .mockImplementation(async (name) => {
        if (name === "api-7bcd") return { name, ownerReferences: [owner] };
        throw NOT_FOUND;
      });

    const { result, router } = await detail(fetch);
    await waitFor(() => expect(result.owners).toEqual([owner]));

    await act(() =>
      router.navigate({ to: "/c/prod/pods/default/web-0" as string })
    );

    await waitFor(() => expect(result.current.error).toBe(NOT_FOUND));
    expect(result.current.name).toBe("web-0");
    expect(result.owners).toBeUndefined();
  });
});

describe("a detail page whose object is made again under its name", () => {
  const KEY = queryKeys.detail("Pod", "default", "api-7bcd");

  /**
   * Sam closed big-pull's page after deleting it, applied it again and
   * opened the page: for a frame it said "This Deployment no longer exists"
   * from the deletion before. Fails if a NotFound answered before the page
   * opened is drawn while the page's own read is on its way.
   */
  it("draws no NotFound from before it opened while its own read is on its way", async () => {
    const client = testQueryClient();
    client.setQueryData(KEY, { name: "api-7bcd" });
    await client
      .fetchQuery({ queryKey: KEY, queryFn: () => Promise.reject(NOT_FOUND) })
      .catch(() => undefined);
    let release: (pod: Pod) => void = () => {};
    const fetch = vi
      .fn<(name: string) => Promise<Pod>>()
      .mockReturnValueOnce(new Promise<Pod>((resolve) => (release = resolve)));

    const { result } = await detail(fetch, client);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(true);
    expect(result.current.resource).toBeUndefined();

    await act(async () => release({ name: "api-7bcd" }));
    await waitFor(() => expect(result.current.resource).toBeDefined());
  });

  /**
   * Once the watch on its name lists the object again, a page still holding
   * the NotFound is behind it. Fails if "no longer exists" is drawn beside
   * an object the watch has seen since.
   */
  it("draws no NotFound once the watch on its name has seen the object since", async () => {
    let release: (pod: Pod) => void = () => {};
    const fetch = vi
      .fn<(name: string) => Promise<Pod>>()
      .mockResolvedValueOnce({ name: "api-7bcd" })
      .mockRejectedValueOnce(NOT_FOUND)
      .mockReturnValue(new Promise<Pod>((resolve) => (release = resolve)));
    const client = testQueryClient();
    const { result } = await detail(fetch, client);
    await waitFor(() => expect(result.current.resource).toBeDefined());
    result.current.refetch();
    await waitFor(() => expect(result.current.error).toBe(NOT_FOUND));

    await act(async () => {
      client.setQueryData(queryKeys.objectWatch("Pod", "default", "api-7bcd"), {
        rows: [{ name: "api-7bcd", namespace: "default" }],
        unread: [],
      });
    });

    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.isLoading).toBe(true);
    await act(async () => release({ name: "api-7bcd" }));
    await waitFor(() => expect(result.current.resource).toBeDefined());
  });
});

describe("a page left open on a pod a restart replaced", () => {
  /**
   * Lena's app.log: the deleted pod's page and its Connections each logged
   * an ERROR, and the page came back to log its lineage too. Fails if the
   * page keeps asking about a pod that is gone, or if the log says it in
   * more than one line, or as an error.
   */
  it("says gone, stops asking, and logs one line for the page and its readers", async () => {
    logged.lines.length = 0;
    const client = new QueryClient({
      queryCache: new QueryCache({ onError: logQueryFailure }),
      defaultOptions: {
        queries: { retry: false, structuralSharing: shareStructure },
      },
    });
    const pod = "api-7bcd";
    const fetch = vi
      .fn<(name: string) => Promise<Pod>>()
      .mockResolvedValueOnce({ name: pod })
      .mockRejectedValue(
        Object.assign(
          new Error(
            `Tauri command 'getPod' failed: Kubernetes API error: pods "${pod}" not found`
          ),
          { code: "NOT_FOUND" }
        )
      );
    const connections = vi.fn(async () => {
      throw Object.assign(
        new Error(
          `Tauri command 'getResourceConnections' failed: Resource not found: Pod/${pod} in namespace default`
        ),
        { code: "NOT_FOUND" }
      );
    });
    const result = {} as { current: UseResourceDetailResult<Pod> };
    function Page() {
      result.current = useResourceDetail<Pod>({
        resourceKind: "Pod",
        fetchResource: (name) => fetch(name),
        refresh: "fast",
      });
      useLiveQuery({
        queryKey: ["connections", "Pod", "default", pod, null],
        queryFn: connections,
        refresh: "fast",
      });
      return null;
    }
    await renderWithRouter(<Page />, {
      client,
      at: PATH,
      route: "/c/$cluster/pods/$namespace/$name",
    });

    await waitFor(
      () => expect(result.current.error?.message ?? "").toMatch(/not found/),
      { timeout: 4000 }
    );
    const asked = fetch.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(fetch).toHaveBeenCalledTimes(asked);
    expect(connections).toHaveBeenCalledTimes(1);
    expect(logged.lines).toEqual(["INFO Query found the object gone"]);
  }, 10_000);
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
