import { act, renderHook, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

const bus = vi.hoisted(() => ({
  handlers: [] as Array<(event: { payload: unknown }) => void>,
}));

vi.mock("@/lib/events", () => ({
  listenEvent: vi.fn(async () => () => {}),
  listenResourceEvents: vi.fn(
    async (handler: (typeof bus.handlers)[number]) => {
      bus.handlers.push(handler);
      return () => {};
    }
  ),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    getNamespace: vi.fn(async () => ({ uid: "uid-1" })),
    subscribeDeploymentWatch: vi.fn(async () => "deploy"),
    subscribeStatefulsetWatch: vi.fn(async () => "sts"),
    subscribeDaemonsetWatch: vi.fn(async () => "ds"),
    resourceWatchSubscribed: vi.fn(async () => {}),
    unsubscribeResourceWatch: vi.fn(async () => {}),
  },
}));

import { commands } from "@/lib/commands";
import { gapsOf } from "@/lib/changes";
import { useChangeJournalStore } from "@/stores/changeJournalStore";
import { useClusterStore } from "@/stores/clusterStore";
import { useChangeJournal } from "./useChangeJournal";

const REFUSED =
  'ApiError: daemonsets.apps is forbidden: User "system:serviceaccount:team-checkout:marco" cannot list resource "daemonsets": Forbidden';

const emit = (
  stream: string,
  op: string | string[],
  error: string | null = null
) =>
  act(() => {
    for (const handler of bus.handlers)
      handler({
        payload: {
          stream_id: stream,
          changes: [op].flat().map((each) => ({ op: each, resource: null })),
          error,
        },
      });
  });

const span = () => useChangeJournalStore.getState().spans.dev?.at(-1);

beforeEach(() => {
  bus.handlers = [];
  useChangeJournalStore.setState({ entries: [], spans: {}, identities: {} });
  // Each test is a connection of its own: a refused watch is remembered per one.
  useClusterStore.setState((s) => ({
    currentContext: "dev",
    isConnected: true,
    namespaceScope: ["team-checkout"],
    connectionAttemptId: s.connectionAttemptId + 1,
  }));
});

async function journal() {
  renderHook(() => useChangeJournal());
  await waitFor(() => expect(bus.handlers).toHaveLength(3));
  await emit("deploy", "synced");
  await emit("sts", "synced");
}

describe("the change journal under a refused kind", () => {
  /**
   * DaemonSets refused in the reader's namespace held the whole journal
   * shut, and Changes said "not watching" beside live lists.
   */
  it("watches what it may and names the kind it was refused", async () => {
    await journal();
    expect(span()).toBeUndefined();
    await emit("ds", "failed", REFUSED);
    expect(span()).toMatchObject({
      to: null,
      unwatched: ["DaemonSet"],
      scope: ["team-checkout"],
    });
  });

  /**
   * What Marco's app really receives: kube announces every list attempt with
   * a restarted marker, so the refused DaemonSet watch sends one before each
   * 403 and again on every retry after the failure. Fails if a retry of a
   * refused watch closes the span the other kinds keep open.
   */
  it("keeps watching through the retries of the refused kind", async () => {
    renderHook(() => useChangeJournal());
    await waitFor(() => expect(bus.handlers).toHaveLength(3));
    await emit("ds", "restarted");
    await emit("deploy", ["restarted", "synced"]);
    await emit("sts", ["restarted", "synced"]);
    await emit("ds", "restarted");
    await emit("ds", "restarted");
    await emit("ds", "failed", REFUSED);
    await emit("ds", "restarted");
    await emit("ds", "restarted");
    expect(useChangeJournalStore.getState().spans.dev).toHaveLength(1);
    expect(span()).toMatchObject({ to: null, unwatched: ["DaemonSet"] });
  });

  /** Fails if the rule above swallowed a real relist, which is a stretch nobody watched. */
  it("still ends the span when a kind it was watching relists", async () => {
    await journal();
    await emit("ds", "failed", REFUSED);
    await emit("deploy", "restarted");
    expect(span()?.to).not.toBeNull();
  });

  /** A watch that failed for any other reason is unknown, not refused: still no span. */
  it("keeps the span shut while a watch fails for another reason", async () => {
    await journal();
    await emit("ds", "failed", "connection reset by peer");
    expect(span()).toBeUndefined();
  });
});

describe("a kind refused on this connection", () => {
  /**
   * Marco's DaemonSet watch was subscribed and refused again on every scope
   * switch, two warnings in the log each time. Fails if the journal asks a
   * watch it was refused on this connection, or waits on it to open a span.
   */
  it("is not subscribed again, and the span names it at once", async () => {
    const view = renderHook(() => useChangeJournal());
    await waitFor(() => expect(bus.handlers).toHaveLength(3));
    await emit("deploy", "synced");
    await emit("sts", "synced");
    await emit("ds", "failed", REFUSED);
    view.unmount();
    vi.mocked(commands.subscribeDaemonsetWatch).mockClear();
    bus.handlers = [];

    renderHook(() => useChangeJournal());
    await waitFor(() => expect(bus.handlers).toHaveLength(2));
    await emit("deploy", "synced");
    await emit("sts", "synced");

    expect(commands.subscribeDaemonsetWatch).not.toHaveBeenCalled();
    expect(span()).toMatchObject({ to: null, unwatched: ["DaemonSet"] });
  });
});

describe("the change journal across a namespace switch", () => {
  const KIND_IDS = [
    [commands.subscribeDeploymentWatch, "deploy"],
    [commands.subscribeStatefulsetWatch, "sts"],
    [commands.subscribeDaemonsetWatch, "ds"],
  ] as const;
  const syncAll = async (namespace: string) => {
    for (const [, id] of KIND_IDS) await emit(`${id}:${namespace}`, "synced");
  };
  const spans = () => useChangeJournalStore.getState().spans.dev ?? [];
  const unsubscribed = () =>
    vi.mocked(commands.unsubscribeResourceWatch).mock.calls.map(([id]) => id);
  let now = 1_000_000;
  let view: { unmount: () => void };
  const later = (ms: number) => {
    now += ms;
    vi.setSystemTime(now);
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    vi.mocked(commands.unsubscribeResourceWatch).mockClear();
    for (const [subscribe, id] of KIND_IDS)
      vi.mocked(subscribe).mockImplementation(
        async (scope) => `${id}:${scope?.[0]}`
      );
    view = renderHook(() => useChangeJournal());
    await waitFor(() => expect(bus.handlers).toHaveLength(3));
    await syncAll("team-checkout");
    later(60_000);
    act(() => useClusterStore.setState({ namespaceScope: ["shop"] }));
    await waitFor(() => expect(bus.handlers).toHaveLength(6));
    later(1_500);
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const [subscribe, id] of KIND_IDS)
      vi.mocked(subscribe).mockImplementation(async () => id);
  });

  /**
   * Lena saw "Не наблюдали 1 секунду" on Changes after every scope switch:
   * the old watches stopped before the new ones had their baselines. Fails
   * if the switch draws a gap or stops the old watches before the new sync.
   */
  it("keeps watching the old scope until the new one has synced, and draws no gap", async () => {
    expect(unsubscribed()).toEqual([]);
    expect(spans().at(-1)).toMatchObject({
      to: null,
      scope: ["team-checkout"],
    });

    await syncAll("shop");

    const [before, after] = spans();
    expect(before.to).toBe(after.from);
    expect(after).toMatchObject({ to: null, scope: ["shop"] });
    expect(gapsOf(spans(), before.from, now)).toEqual([]);
    expect(unsubscribed().sort()).toEqual([
      "deploy:team-checkout",
      "ds:team-checkout",
      "sts:team-checkout",
    ]);
  });

  /** Fails if the hand-over hides a stretch the new scope really went unwatched. */
  it("still draws a gap when the new scope's watch fails before it syncs", async () => {
    await emit("deploy:shop", "failed", "connection reset by peer");
    const failedAt = now;
    later(20_000);
    await emit("deploy:shop", ["restarted", "synced"]);
    await emit("sts:shop", "synced");
    await emit("ds:shop", "synced");

    const [before] = spans();
    expect(gapsOf(spans(), before.from, now)).toEqual([
      { from: failedAt, to: now },
    ]);
  });

  /** Fails if the watches kept for the hand-over outlive the journal itself. */
  it("stops the old scope's watches when the journal goes away mid-switch", () => {
    view.unmount();
    expect(unsubscribed()).toEqual(
      expect.arrayContaining([
        "deploy:team-checkout",
        "sts:team-checkout",
        "ds:team-checkout",
      ])
    );
    expect(spans().at(-1)?.to).toBe(now);
  });
});

describe("one change seen by two scopes' watches", () => {
  const KIND_IDS = [
    [commands.subscribeDeploymentWatch, "deploy"],
    [commands.subscribeStatefulsetWatch, "sts"],
    [commands.subscribeDaemonsetWatch, "ds"],
  ] as const;
  let opened = 0;
  const latest = (subscribe: (typeof KIND_IDS)[number][0]) =>
    vi.mocked(subscribe).mock.results.at(-1)?.value as Promise<string>;
  const send = (stream: string, changes: Array<[string, unknown]>) =>
    act(() => {
      for (const handler of bus.handlers)
        handler({
          payload: {
            stream_id: stream,
            changes: changes.map(([op, resource]) => ({ op, resource })),
            error: null,
          },
        });
    });
  const deployment = (name: string, generation: number, replicas: number) => ({
    name,
    namespace: "lena-sandbox",
    uid: `uid-${name}`,
    createdAt: `2026-10-06T18:37:00Z`,
    generation,
    replicas: {
      desired: replicas,
      ready: replicas,
      available: replicas,
      updated: replicas,
    },
    containers: [{ name: "web", image: "nginx:1.27" }],
    initContainers: [],
    templateAnnotations: {},
  });
  const relist = async (rows: unknown[]) => {
    await send(await latest(commands.subscribeDeploymentWatch), [
      ["restarted", null],
      ...rows.map((row): [string, unknown] => ["applied", row]),
      ["synced", null],
    ]);
  };
  const syncRest = async () => {
    for (const subscribe of [
      commands.subscribeStatefulsetWatch,
      commands.subscribeDaemonsetWatch,
    ])
      await send(await latest(subscribe), [
        ["restarted", null],
        ["synced", null],
      ]);
  };
  const scope = async (namespaces: string[]) => {
    const before = bus.handlers.length;
    act(() => useClusterStore.setState({ namespaceScope: namespaces }));
    await waitFor(() => expect(bus.handlers).toHaveLength(before + 3));
  };
  const written = () =>
    useChangeJournalStore
      .getState()
      .entries.map(
        (e) =>
          `${e.name} ${e.field} ${e.from}->${e.to}${e.atRelist ? " relist" : ""}`
      );

  beforeEach(async () => {
    for (const [subscribe, id] of KIND_IDS)
      vi.mocked(subscribe).mockImplementation(
        async (namespaces) => `${id}:${namespaces?.[0] ?? "*"}:${(opened += 1)}`
      );
    useClusterStore.setState({ namespaceScope: [] });
    renderHook(() => useChangeJournal());
    await waitFor(() => expect(bus.handlers).toHaveLength(3));
    await relist([deployment("hello-web", 3, 1)]);
    await syncRest();
  });

  afterEach(() => {
    for (const [subscribe, id] of KIND_IDS)
      vi.mocked(subscribe).mockImplementation(async () => id);
  });

  /**
   * Lena scaled hello-web while on All namespaces, then picked lena-sandbox:
   * the relist compared against what lena-sandbox's own watch saw minutes
   * earlier and wrote the scale a second time. Fails if a change one scope's
   * watch recorded is recorded again by another scope's relist.
   */
  it("records a change seen under All namespaces once after switching to its namespace", async () => {
    await scope(["lena-sandbox"]);
    await relist([deployment("hello-web", 3, 1)]);
    await syncRest();
    await scope([]);
    await relist([deployment("hello-web", 3, 1)]);
    await syncRest();

    await send(await latest(commands.subscribeDeploymentWatch), [
      ["applied", deployment("hello-web", 4, 2)],
    ]);
    await scope(["lena-sandbox"]);
    await relist([deployment("hello-web", 4, 2)]);
    await syncRest();

    expect(written()).toEqual([
      "hello-web generation 3->4",
      "hello-web replicas 1->2",
    ]);
  });

  /**
   * While the old scope's watches wait for the new scope to sync, both see
   * every change, and one may run behind the other. Fails if the overlap
   * writes a change twice or the lagging watch writes it backwards.
   */
  it("records each change once while both scopes' watches deliver it", async () => {
    const all = await latest(commands.subscribeDeploymentWatch);
    await scope(["lena-sandbox"]);
    await relist([deployment("hello-web", 3, 1)]);
    const sandbox = await latest(commands.subscribeDeploymentWatch);

    const scaled = [
      ["applied", deployment("hello-web", 4, 2)],
      ["applied", deployment("hello-web", 5, 3)],
    ] as Array<[string, unknown]>;
    await send(all, scaled);
    await send(sandbox, scaled);
    await syncRest();

    expect(written()).toEqual([
      "hello-web generation 3->4",
      "hello-web replicas 1->2",
      "hello-web generation 4->5",
      "hello-web replicas 2->3",
    ]);
  });

  /** Fails if a lagging watch's echo of a deleted object writes it back as created. */
  it("records a deletion during the hand-over once, and the lagging watch does not revive it", async () => {
    const all = await latest(commands.subscribeDeploymentWatch);
    await scope(["lena-sandbox"]);
    await relist([deployment("hello-web", 3, 1)]);
    const sandbox = await latest(commands.subscribeDeploymentWatch);

    await send(all, [["deleted", deployment("hello-web", 3, 1)]]);
    await send(sandbox, [
      ["applied", deployment("hello-web", 3, 1)],
      ["deleted", deployment("hello-web", 3, 1)],
    ]);
    await syncRest();

    expect(written()).toEqual(["hello-web deleted null->null"]);
  });

  /**
   * The new scope lists before the old scope's watch sees a Deployment
   * created. Fails if that list's silence about it is written as a deletion.
   */
  it("does not read a list taken before a creation as that object's deletion", async () => {
    const all = await latest(commands.subscribeDeploymentWatch);
    await scope(["lena-sandbox"]);
    const sandbox = await latest(commands.subscribeDeploymentWatch);
    await send(sandbox, [
      ["restarted", null],
      ["applied", deployment("hello-web", 3, 1)],
    ]);
    await send(all, [["applied", deployment("api", 1, 1)]]);
    await send(sandbox, [["synced", null]]);
    await send(sandbox, [["applied", deployment("api", 1, 1)]]);
    await syncRest();

    expect(written()).toEqual(["api created null->null"]);
  });
});
