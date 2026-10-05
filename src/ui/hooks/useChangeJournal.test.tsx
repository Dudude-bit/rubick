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

const emit = (stream: string, op: string, error: string | null = null) =>
  act(() => {
    for (const handler of bus.handlers)
      handler({
        payload: {
          stream_id: stream,
          changes: [{ op, resource: null }],
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

  /** A watch that failed for any other reason is unknown, not refused: still no span. */
  it("keeps the span shut while a watch fails for another reason", async () => {
    await journal();
    await emit("ds", "failed", "connection reset by peer");
    expect(span()).toBeUndefined();
  });
});
