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
import { markNavigation } from "@/lib/navigation-clock";
import { logQueryFailure } from "@/lib/query-log";
import { shareStructure } from "@/lib/watched-rows";
import { renderWithRouter, testQueryClient } from "@/test/render";
import { useLiveQuery } from "./useLiveQuery";
import {
  useResourceDetail,
  type UseResourceDetailResult,
} from "./useResourceDetail";
import { useLastOwners, type KnownOwners, type Owner } from "./useLastOwners";
import { useScopeTabStore } from "@/stores/scopeTabStore";
import { useWindowActivity } from "@/lib/window-activity";

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
    owners: KnownOwners;
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

describe("a detail page whose own read fails while a list holds its object", () => {
  const listed = (rows: Pod[], at: number) => {
    const client = testQueryClient();
    client.setQueryData(
      ["pods", "all"],
      {
        rows: rows.map((row) => ({ ...row, namespace: "default" })),
        unread: [],
      },
      { updatedAt: at }
    );
    return client;
  };

  /**
   * Shots r5-73/74: the list and the peek both held the Deployment and its
   * page drew only "Could not read". Fails if the page does not draw the
   * list's row, or draws it without saying it is from that list's read.
   */
  it("draws the list's row, said to be from the list's read", async () => {
    const at = Date.now() - 30_000;
    const fetch = vi
      .fn<(name: string) => Promise<Pod>>()
      .mockRejectedValue(new Error("500 from get"));

    const { result } = await detail(fetch, listed([{ name: "api-7bcd" }], at));
    await waitFor(() => expect(result.current.resource).toBeDefined());

    expect(result.current.resource?.name).toBe("api-7bcd");
    expect(result.current.error).toBeNull();
    expect(result.current.freshness.stale).toBe(true);
    expect(result.current.freshness.dataUpdatedAt).toBe(at);
    expect(String(result.current.freshness.failure)).toContain("500 from get");
  });

  /** Fails if a row of another object stands in, or the failure stops being the page when nothing is held. */
  it("says only the failure when the list holds no row of it", async () => {
    const fetch = vi
      .fn<(name: string) => Promise<Pod>>()
      .mockRejectedValue(new Error("500 from get"));

    const { result } = await detail(
      fetch,
      listed([{ name: "api-other" }], Date.now())
    );
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.resource).toBeUndefined();
  });

  /** A 404 is the object gone, not a dropped read: fails if the list's older row is drawn over it. */
  it("never draws the list's row over an object the cluster says is gone", async () => {
    const fetch = vi
      .fn<(name: string) => Promise<Pod>>()
      .mockRejectedValue(NOT_FOUND);

    const { result } = await detail(
      fetch,
      listed([{ name: "api-7bcd" }], Date.now())
    );
    await waitFor(() => expect(result.current.error).toBe(NOT_FOUND));
    expect(result.current.resource).toBeUndefined();
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

describe("a detail page moved to another object of its kind", () => {
  /**
   * The hook handed back the object before until the next one answered, and
   * deleted by the address: every page drew one object in full over a Delete
   * that reached another. A page is mounted anew for each object, which is
   * the only thing that ends it. Fails if the page is told of any object
   * while the one its address names is still being read.
   */
  it("holds nothing of the object before while the next one is read", async () => {
    const fetch = vi
      .fn<(name: string) => Promise<Pod>>()
      .mockImplementation((name) =>
        name === "api-7bcd"
          ? Promise.resolve({ name })
          : new Promise<Pod>(() => {})
      );

    const { result, router } = await detail(fetch);
    await waitFor(() => expect(result.current.resource).toBeDefined());

    await act(() =>
      router.navigate({ to: "/c/prod/pods/default/web-0" as string })
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("web-0"));

    expect(result.current.name).toBe("web-0");
    expect(result.current.resource).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
  });
});

describe("a detail page whose object is gone, of a kind no watch follows by name", () => {
  /** The page of `kind` at an address, and what it is told. */
  async function page(kind: string, fetch: (name: string) => Promise<Pod>) {
    const result = {} as { current: UseResourceDetailResult<Pod> };
    function Probe() {
      result.current = useResourceDetail<Pod>({
        resourceKind: kind,
        fetchResource: (name) => fetch(name),
      });
      return null;
    }
    await renderWithRouter(<Probe />, {
      at: "/c/prod/things/default/app",
      route: "/c/$cluster/things/$namespace/$name",
    });
    return result;
  }
  const comeBack = () => {
    act(() => useWindowActivity.setState({ focused: false }));
    act(() => useWindowActivity.setState({ focused: true }));
  };
  /** Gone at the first read, and made again after it. */
  const madeAgain = () =>
    vi
      .fn<(name: string) => Promise<Pod>>()
      .mockRejectedValueOnce(NOT_FOUND)
      .mockResolvedValue({ name: "app" });

  /**
   * Fourteen kinds have no watch by name, and their page stopped reading at
   * NotFound: a ConfigMap made again a second later stayed "no longer
   * exists" for as long as the page was open, with only Go back to press.
   * Fails if such a page does not read again when the reader returns to it.
   */
  it.each(["ConfigMap", "Secret", "Ingress", "Widget"])(
    "reads a %s again when the reader comes back, and finds it",
    async (kind) => {
      const fetch = madeAgain();
      const result = await page(kind, fetch);
      await waitFor(() => expect(result.current.error).toBe(NOT_FOUND));

      comeBack();

      await waitFor(() =>
        expect(result.current.resource).toEqual({ name: "app" })
      );
      expect(result.current.error).toBeNull();
    }
  );

  /** A kind the watch follows by name hears of the object from the watch. Fails if its page is read again as well. */
  it("leaves a gone Pod to the watch on its name", async () => {
    const fetch = madeAgain();
    const result = await page("Pod", fetch);
    await waitFor(() => expect(result.current.error).toBe(NOT_FOUND));

    comeBack();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBe(NOT_FOUND);
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
   * The route's loader reads the object when the navigation starts and the
   * page mounts after its chunk lands, so a 404 can be in before the page
   * exists. Fails if that answer is treated as one from before the page
   * opened: asking again puts the query back to loading and the skeleton
   * waits out a second read for nothing.
   */
  it("draws the NotFound its own navigation read before it mounted", async () => {
    const client = testQueryClient();
    markNavigation();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await client
      .fetchQuery({ queryKey: KEY, queryFn: () => Promise.reject(NOT_FOUND) })
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const fetch = vi
      .fn<(name: string) => Promise<Pod>>()
      .mockReturnValue(new Promise<Pod>(() => {}));

    try {
      const { result } = await detail(fetch, client);
      expect(result.current.error).toBe(NOT_FOUND);
      expect(result.current.isLoading).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      markNavigation(0);
    }
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

describe("a detail page whose object the reader deletes", () => {
  /**
   * The page went back through the window's history, which is one for every
   * tab and has nothing behind it at launch: after a delete in a tab
   * restored onto the object, the page stayed on what was just deleted.
   * Fails if the delete does not ask the tab itself to leave the page.
   */
  it("asks its tab to leave the page, whatever the window's history holds", async () => {
    useScopeTabStore.setState({
      tabs: [
        { id: "a", context: "prod", namespace: "", href: PATH, missing: false },
      ],
      activeId: "a",
      pendingHref: null,
    });
    const result = {} as { current: UseResourceDetailResult<Pod> };
    function Probe() {
      result.current = useResourceDetail<Pod>({
        resourceKind: "Pod",
        fetchResource: async () => ({ name: "api-7bcd" }),
        deleteResource: async () => {},
        refresh: false,
      });
      return null;
    }
    await renderWithRouter(<Probe />, {
      at: PATH,
      route: "/c/$cluster/pods/$namespace/$name",
    });

    await act(async () => {
      await result.current.deleteMutation?.mutateAsync();
    });

    expect(useScopeTabStore.getState().pendingHref).toBe("/c/prod/pods");
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
