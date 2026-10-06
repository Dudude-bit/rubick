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
  useClusterStore.setState({
    currentContext: "dev",
    isConnected: true,
    namespaceScope: ["team-checkout"],
  });
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
