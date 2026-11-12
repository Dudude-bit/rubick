import type { ReactNode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const getClusterOverview = vi.fn();
const followClusterOverview = vi.fn();
const subscribeDeploymentWatch = vi.fn(
  async (_scope: string[] | null) => "deploy"
);
vi.mock("@/lib/commands", () => ({
  commands: {
    getClusterOverview: (scope: string[] | null) => getClusterOverview(scope),
    followClusterOverview: (scope: string[] | null) =>
      followClusterOverview(scope),
    subscribeDeploymentWatch: (scope: string[] | null) =>
      subscribeDeploymentWatch(scope),
    resourceWatchSubscribed: async () => {},
    unsubscribeResourceWatch: async () => {},
  },
}));

import { listen } from "@tauri-apps/api/event";

import { forgetChannels } from "@/lib/events";
import { useWindowActivity } from "@/lib/window-activity";
import { useClusterStore } from "@/stores/clusterStore";
import {
  blindDeployments,
  useClusterOverview,
  useFollowedOverview,
  useOverviewFollowedAt,
  useScopedOverview,
  WATCHED_COUNTS,
} from "./useClusterOverview";

const overview = (pods: number) => ({ counts: { pods } }) as never;

let client: QueryClient;

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

beforeEach(() => {
  getClusterOverview.mockReset();
  followClusterOverview.mockReset();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  useClusterStore.setState({
    currentContext: "prod-eu",
    isConnected: true,
  });
});

afterEach(() => {
  useClusterStore.setState({
    isConnected: false,
    currentContext: null,
    namespaceScope: [],
  });
});

/**
 * The rail states counts beside the name of the cluster the window is on.
 * `keepPreviousData` answers a brand-new key with the last one's answer, and
 * a context switch is a brand-new key — so one cluster's totals were drawn
 * under another cluster's name, including on a cluster that refuses to list
 * the things being counted.
 */
describe("useClusterOverview", () => {
  it("holds no counts for a cluster it has not read yet", async () => {
    getClusterOverview.mockResolvedValueOnce(overview(51));
    const { result } = renderHook(() => useClusterOverview([]), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    // The second cluster is slow, or refuses: either way nothing has come
    // back from it, and the rail must not fill the gap with the first one.
    getClusterOverview.mockImplementationOnce(
      () => new Promise(() => undefined)
    );
    act(() => useClusterStore.setState({ currentContext: "staging-eu" }));

    await waitFor(() => expect(getClusterOverview).toHaveBeenCalledTimes(2));
    expect(result.current.data).toBeUndefined();
  });

  it("keeps the counts it has while the same cluster is asked a narrower question", async () => {
    getClusterOverview.mockResolvedValueOnce(overview(51));
    const { result, rerender } = renderHook(
      ({ scope }: { scope: string[] }) => useClusterOverview(scope),
      { wrapper, initialProps: { scope: [] as string[] } }
    );
    await waitFor(() => expect(result.current.data).toBeDefined());

    getClusterOverview.mockImplementationOnce(
      () => new Promise(() => undefined)
    );
    rerender({ scope: ["shop"] });

    await waitFor(() => expect(getClusterOverview).toHaveBeenCalledTimes(2));
    expect(result.current.data).toEqual(overview(51));
  });

  /**
   * Would put the last selection's totals under a label naming several
   * namespaces. The skeleton is one read away; a number beside the wrong
   * label is not a placeholder.
   */
  it("holds no counts while a new set of namespaces is read", async () => {
    getClusterOverview.mockResolvedValueOnce(overview(51));
    const { result, rerender } = renderHook(
      ({ scope }: { scope: string[] }) => useClusterOverview(scope),
      { wrapper, initialProps: { scope: [] as string[] } }
    );
    await waitFor(() => expect(result.current.data).toBeDefined());

    getClusterOverview.mockImplementationOnce(
      () => new Promise(() => undefined)
    );
    rerender({ scope: ["prod", "staging"] });

    await waitFor(() => expect(getClusterOverview).toHaveBeenCalledTimes(2));
    expect(result.current.data).toBeUndefined();
  });

  /**
   * The backend refuses an empty list rather than read it as the whole
   * cluster, so "every namespace" has to go over the wire as `null`.
   */
  it("asks for the whole cluster as null", async () => {
    getClusterOverview.mockResolvedValueOnce(overview(51));
    renderHook(() => useClusterOverview([]), { wrapper });
    await waitFor(() => expect(getClusterOverview).toHaveBeenCalledWith(null));
  });
});

describe("useScopedOverview", () => {
  /**
   * The point of moving the join to Rust. Asked once per namespace, every
   * part re-read the cluster's nodes and — when listing — its every pod, so
   * four namespaces were five whole-cluster pod lists a poll.
   */
  it("asks once for a window on several namespaces, naming every one", async () => {
    useClusterStore.setState({ namespaceScope: ["prod", "staging"] });
    getClusterOverview.mockResolvedValue(overview(11));

    const { result } = renderHook(() => useScopedOverview(), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual(overview(11)));
    expect(getClusterOverview).toHaveBeenCalledTimes(1);
    expect(getClusterOverview).toHaveBeenCalledWith(["prod", "staging"]);
  });
});

describe("an overview served from the watched stores", () => {
  let announce: ((event: { payload: unknown }) => void) | null = null;
  const changed = (namespaces: string[], cluster = false) =>
    act(() =>
      announce?.({
        payload: {
          channel: "overview-changed",
          context: "prod-eu",
          namespaces,
          cluster,
        },
      })
    );

  beforeEach(() => {
    forgetChannels();
    announce = null;
    vi.mocked(listen).mockImplementation(async (event, handler) => {
      if (event === "overview-changed") announce = handler as typeof announce;
      return () => {};
    });
    useWindowActivity.setState({ visible: true });
  });

  const served = (pods: number, services = 3) => ({
    servedFrom: "watch",
    counts: { pods, services },
  });
  const KEY = ["cluster-overview", "prod-eu", "shop"];
  const held = () => client.getQueryData<{ counts: { pods: number } }>(KEY);

  function follow(servedFrom: "watch" | "list") {
    getClusterOverview.mockResolvedValue({ servedFrom, counts: { pods: 40 } });
    return renderHook(
      () => {
        const query = useScopedOverview();
        return useFollowedOverview(query.data);
      },
      { wrapper }
    );
  }

  /** The shop's overview, followed, and how many whole reads that took. */
  async function followed() {
    useClusterStore.setState({ namespaceScope: ["shop"] });
    const { result } = follow("watch");
    await waitFor(() => expect(result.current).toBe(true));
    await waitFor(() => expect(announce).not.toBeNull());
    return getClusterOverview.mock.calls.length;
  }

  /** A read the test answers when it says. */
  function pending<T>() {
    let land: (value: T) => void = () => {};
    const read = new Promise<T>((resolve) => (land = resolve));
    return { read, land: (value: T) => act(async () => land(value)) };
  }

  /**
   * Sam's Overview read "41 of 62 pods ready" for six seconds after kubectl
   * was back at 40, on a ten-second poll over stores that knew at once. And
   * each change then read the whole overview: a dozen requests to the
   * cluster, up to once a second. Fails if a change the stores announce in
   * the window's scope is not followed, if one elsewhere is, if following
   * reads the whole overview, or if it moves when the counts were counted.
   */
  it("follows a change its stores announce in its scope, and asks the cluster's counts nothing for it", async () => {
    const reads = await followed();
    expect(client.getQueryData(KEY)).toBeDefined();
    const countedAt = client.getQueryState(KEY)!.dataUpdatedAt;
    followClusterOverview.mockResolvedValue(served(41));

    await changed(["team-blind"]);
    await new Promise((settle) => setTimeout(settle, 50));
    expect(followClusterOverview).not.toHaveBeenCalled();

    await changed(["shop"]);
    await waitFor(() => expect(held()?.counts.pods).toBe(41));
    expect(followClusterOverview).toHaveBeenCalledWith(["shop"]);
    followClusterOverview.mockResolvedValue(served(42));
    await changed([], true);
    await waitFor(() => expect(held()?.counts.pods).toBe(42));

    expect(followClusterOverview).toHaveBeenCalledTimes(2);
    expect(getClusterOverview).toHaveBeenCalledTimes(reads);
    expect(client.getQueryState(KEY)!.dataUpdatedAt).toBe(countedAt);
  });

  /**
   * The counts a follow moved were printed under the whole read's time:
   * "Counted at 15:03:41" beside a number from six seconds later. Fails if
   * a follow does not say when the stores answered, or says it for a scope
   * that was not followed.
   */
  it("says when its stores last answered, which the whole read's time is not", async () => {
    await followed();
    const { result } = renderHook(() => useOverviewFollowedAt(), { wrapper });
    const countedAt = client.getQueryState(KEY)!.dataUpdatedAt;
    followClusterOverview.mockResolvedValue(served(41));

    await new Promise((later) => setTimeout(later, 5));
    const before = Date.now();
    await changed(["shop"]);
    await waitFor(() => expect(held()?.counts.pods).toBe(41));

    expect(before).toBeGreaterThan(countedAt);
    expect(result.current).toBeGreaterThanOrEqual(before);
    act(() => useClusterStore.setState({ namespaceScope: ["team-blind"] }));
    expect(result.current).toBeNull();
  });

  /**
   * A rollout is a change every 50 ms. Fails if each announcement is asked
   * of the backend on its own rather than one at a time, or if the changes
   * announced while one was out are not followed once it is back.
   */
  it("follows one change at a time, and the ones announced meanwhile together", async () => {
    await followed();
    const first = pending<unknown>();
    followClusterOverview.mockReturnValueOnce(first.read);
    followClusterOverview.mockResolvedValue(served(45));

    for (let burst = 0; burst < 5; burst++) await changed(["shop"]);
    expect(followClusterOverview).toHaveBeenCalledTimes(1);

    await first.land(served(41));
    await waitFor(() => expect(held()?.counts.pods).toBe(45));
    expect(followClusterOverview).toHaveBeenCalledTimes(2);
  });

  /**
   * Sam's drain named the new pod at 114 ms in one run and 676 ms in the
   * next: a change announced while a whole read was on its way waited for
   * an answer that could have left before it. Fails if such a change is not
   * followed once that read lands.
   */
  it("follows again after a whole read that was out when a change was announced", async () => {
    await followed();
    const whole = pending<unknown>();
    getClusterOverview.mockReturnValueOnce(whole.read);
    void client.refetchQueries({ queryKey: KEY });
    followClusterOverview.mockResolvedValue(served(41));

    await changed(["shop"]);
    await waitFor(() => expect(held()?.counts.pods).toBe(41));
    const follows = followClusterOverview.mock.calls.length;

    followClusterOverview.mockResolvedValue(served(42));
    await whole.land({ servedFrom: "watch", counts: { pods: 40 } });
    await waitFor(() => expect(held()?.counts.pods).toBe(42));
    expect(followClusterOverview).toHaveBeenCalledTimes(follows + 1);
  });

  /**
   * A follow carries the counts of the whole read before it. Fails if one
   * that lands after a newer whole read puts those older counts back.
   */
  it("does not put a follow's older counts over a whole read that landed while it was out", async () => {
    await followed();
    const slow = pending<unknown>();
    followClusterOverview.mockReturnValueOnce(slow.read);
    await changed(["shop"]);

    getClusterOverview.mockResolvedValue({
      servedFrom: "watch",
      counts: { pods: 41, services: 4 },
    });
    await act(() => client.refetchQueries({ queryKey: KEY }));
    await slow.land(served(41, 3));

    expect(client.getQueryData(KEY)).toMatchObject({ counts: { services: 4 } });
    // That read left after the change was announced, so it has seen it.
    expect(followClusterOverview).toHaveBeenCalledTimes(1);
  });

  /**
   * Fails if a backend with nothing to follow from, no whole read of this
   * scope or stores that stopped serving, leaves the change unread.
   */
  it("reads the whole overview where the backend has nothing to follow from", async () => {
    const reads = await followed();
    followClusterOverview.mockResolvedValue(null);

    await changed(["shop"]);
    await waitFor(() =>
      expect(getClusterOverview).toHaveBeenCalledTimes(reads + 1)
    );
  });

  /** Fails if an overview listed rather than served from the stores claims to follow them, or listens for them. */
  it("does not follow an overview that was listed", async () => {
    const { result } = follow("list");
    await waitFor(() => expect(getClusterOverview).toHaveBeenCalled());
    expect(result.current).toBe(false);
    expect(announce).toBeNull();
  });
});

const refused = (kind: string, namespace: string | null) => ({
  kind,
  namespace,
  code: "PERMISSION_DENIED",
  message: `${kind} is forbidden`,
});

/** Marco's team-blind: Deployments readable, pods refused, ledger read in one of its Available windows. */
const ledgerReadReady = (unread = [refused("Pod", "team-blind")]) => ({
  servedFrom: "list",
  counts: { pods: null },
  deployments: {
    read: [{ reason: "Ready", count: 1, podsUnread: false }],
    complete: true,
  },
  unread,
});

describe("an overview whose pods went unread", () => {
  let resourceEvent: ((event: { payload: unknown }) => void) | null = null;
  const deploymentChanged = (op: string) =>
    act(() =>
      resourceEvent?.({
        payload: {
          stream_id: "deploy",
          changes: [
            {
              op,
              resource: { name: "ledger", namespace: "team-blind" },
            },
          ],
          error: null,
        },
      })
    );

  beforeEach(() => {
    forgetChannels();
    resourceEvent = null;
    subscribeDeploymentWatch.mockClear();
    vi.mocked(listen).mockImplementation(async (event, handler) => {
      if (event === "resource-event")
        resourceEvent = handler as typeof resourceEvent;
      return () => {};
    });
    useWindowActivity.setState({ visible: true });
    useClusterStore.setState((s) => ({
      namespaceScope: ["team-blind"],
      connectionAttemptId: s.connectionAttemptId + 1,
    }));
  });

  function follow(answer: unknown) {
    getClusterOverview.mockResolvedValue(answer);
    return renderHook(
      () => {
        const query = useScopedOverview();
        return useFollowedOverview(query.data);
      },
      { wrapper }
    );
  }

  /**
   * Marco's team-blind Overview drew ledger green "1 Ready" from a read taken
   * in one of its three-second Available windows, while the Deployments list
   * beside it said Unavailable. Fails if a change on the Deployments' watch
   * does not read the overview again where its pods could not be read.
   */
  it("reads again when a Deployment there changes on its watch", async () => {
    const { result } = follow(ledgerReadReady());
    await waitFor(() =>
      expect(subscribeDeploymentWatch).toHaveBeenCalledWith(["team-blind"])
    );
    await waitFor(() => expect(resourceEvent).not.toBeNull());
    expect(result.current).toBe(false);
    deploymentChanged("synced");
    const reads = getClusterOverview.mock.calls.length;

    deploymentChanged("applied");
    await waitFor(() =>
      expect(getClusterOverview).toHaveBeenCalledTimes(reads + 1)
    );
  });

  /** Fails if an overview that read its pods, and knows a crash loop when it sees one, opens a watch it does not need. */
  it("does not watch Deployments where the pods were read", async () => {
    follow(ledgerReadReady([]));
    await waitFor(() => expect(getClusterOverview).toHaveBeenCalled());
    await new Promise((settle) => setTimeout(settle, 50));
    expect(subscribeDeploymentWatch).not.toHaveBeenCalled();
  });
});

describe("blindDeployments", () => {
  /** Fails if a namespace whose Deployments were refused too is watched, which only collects a 403. */
  it("names the namespaces whose pods were refused and Deployments were not", () => {
    const overview = {
      ...ledgerReadReady([
        refused("Pod", "team-blind"),
        refused("Pod", "vault"),
        refused("Deployment", "vault"),
      ]),
    } as never;
    expect(
      blindDeployments(overview, ["team-checkout", "team-blind", "vault"])
    ).toEqual(["team-blind"]);
  });

  /** Fails if a whole cluster whose pods were refused is not followed across every namespace. */
  it("follows the whole cluster when the cluster-wide pod list was refused", () => {
    expect(
      blindDeployments(ledgerReadReady([refused("Pod", null)]) as never, [])
    ).toBeNull();
  });

  /** Fails if an overview with no Deployment census at all opens a watch. */
  it("watches nothing when no Deployment was read", () => {
    expect(
      blindDeployments({ ...ledgerReadReady(), deployments: null } as never, [
        "team-blind",
      ])
    ).toBeUndefined();
  });
});

describe("the counts the overview's stores hold", () => {
  /**
   * The sidebar says these counts follow the cluster while the overview is
   * served from the backend's stores. Fails if a kind is watched or dropped
   * on one side of `src/contracts/overview-watches.json` alone.
   */
  it("are the kinds src/contracts/overview-watches.json names", () => {
    const shared = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "src/contracts/overview-watches.json"),
        "utf8"
      )
    ) as { kinds: string[] };
    expect(Object.keys(WATCHED_COUNTS)).toEqual(shared.kinds);
  });
});
