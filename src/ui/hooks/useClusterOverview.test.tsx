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
const subscribeDeploymentWatch = vi.fn(
  async (_scope: string[] | null) => "deploy"
);
vi.mock("@/lib/commands", () => ({
  commands: {
    getClusterOverview: (scope: string[] | null) => getClusterOverview(scope),
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

  /**
   * Sam's Overview read "41 of 62 pods ready" for six seconds after kubectl
   * was back at 40, on a ten-second poll over stores that knew at once.
   * Fails if a change the stores announce in the window's scope is not read
   * again, or one elsewhere is.
   */
  it("reads again when its stores announce a change in its scope, and only then", async () => {
    useClusterStore.setState({ namespaceScope: ["shop"] });
    const { result } = follow("watch");
    await waitFor(() => expect(result.current).toBe(true));
    await waitFor(() => expect(announce).not.toBeNull());
    const reads = getClusterOverview.mock.calls.length;

    changed(["team-blind"]);
    await new Promise((settle) => setTimeout(settle, 50));
    expect(getClusterOverview).toHaveBeenCalledTimes(reads);

    changed(["shop"]);
    await waitFor(() =>
      expect(getClusterOverview).toHaveBeenCalledTimes(reads + 1)
    );
    changed([], true);
    await waitFor(() =>
      expect(getClusterOverview).toHaveBeenCalledTimes(reads + 2)
    );
  });

  /**
   * Sam's drain named the new pod at 114 ms in one run and 676 ms in the
   * next: a change announced while a read was on its way joined that read,
   * which could have left before it. Fails if a change announced during a
   * read is not read again once that read lands.
   */
  it("reads again after a read in flight when a change is announced during it", async () => {
    useClusterStore.setState({ namespaceScope: ["shop"] });
    const { result } = follow("watch");
    await waitFor(() => expect(result.current).toBe(true));
    await waitFor(() => expect(announce).not.toBeNull());
    const reads = getClusterOverview.mock.calls.length;
    let land: (value: unknown) => void = () => {};
    getClusterOverview.mockImplementationOnce(
      () => new Promise((resolve) => (land = resolve))
    );

    changed(["shop"]);
    await waitFor(() =>
      expect(getClusterOverview).toHaveBeenCalledTimes(reads + 1)
    );
    changed(["shop"]);
    await new Promise((settle) => setTimeout(settle, 50));
    expect(getClusterOverview).toHaveBeenCalledTimes(reads + 1);

    await act(async () => land({ servedFrom: "watch", counts: { pods: 41 } }));
    await waitFor(() =>
      expect(getClusterOverview).toHaveBeenCalledTimes(reads + 2)
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
