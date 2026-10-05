import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
