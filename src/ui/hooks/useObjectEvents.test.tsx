import { beforeEach, expect, it, vi } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const answer = vi.hoisted(() => ({
  events: [] as unknown[],
  setEvents: [] as unknown[],
  sets: [] as unknown[] | Error,
}));
vi.mock("@/lib/commands", () => ({
  commands: {
    listEvents: (filters: { involved_object_kind: string | null }) =>
      Promise.resolve(
        filters.involved_object_kind === "ReplicaSet"
          ? answer.setEvents
          : answer.events
      ),
    getDeploymentReplicasets: () =>
      answer.sets instanceof Error
        ? Promise.reject(answer.sets)
        : Promise.resolve(answer.sets),
  },
}));

import type { EventInfo } from "@/generated/types";
import { queryKeys } from "@/lib/query-keys";
import { useWindowActivity } from "@/lib/window-activity";
import { testQueryClient } from "@/test/render";
import { ofIncarnation, useObjectEvents } from "./useObjectEvents";
import { useReadUidAt } from "./useReadUid";

const event = (reason: string, uid: string | null): EventInfo => ({
  name: `wd-demo.${reason}`,
  namespace: "lena-sandbox",
  uid: `event-${reason}`,
  type: "Normal",
  reason,
  message: null,
  source: null,
  involvedObject: {
    kind: "Pod",
    name: "wd-demo",
    namespace: "lena-sandbox",
    uid,
  },
  count: 1,
  firstTimestamp: null,
  lastTimestamp: null,
});

beforeEach(() => {
  useWindowActivity.setState({ visible: true });
  answer.events = [
    event("Started", "current"),
    event("Killing", "earlier"),
    event("FailedMount", "earliest"),
    event("Noted", null),
  ];
});

function mount(read: { uid: string } | null) {
  const client = testQueryClient();
  if (read)
    client.setQueryData(
      queryKeys.detail("Pod", "lena-sandbox", "wd-demo"),
      read
    );
  const { result } = renderHook(
    () =>
      useObjectEvents("Pod", "wd-demo", "lena-sandbox", { refresh: "slow" }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    }
  );
  return result;
}

/**
 * Lena's wd-demo, deleted and created twice, listed fifteen events on its
 * page and peek, eleven about the pods before it: a FailedMount for a volume
 * it does not have. Fails if an event naming another uid is kept once the
 * pod has been read, or one that names none is dropped.
 */
it("keeps the events of the incarnation that was read, and those naming none", async () => {
  const result = mount({ uid: "current" });
  await waitFor(() => expect(result.current.data).toBeDefined());
  expect(result.current.data?.map((e) => e.reason)).toEqual([
    "Started",
    "Noted",
  ]);
});

/** Fails if events are dropped before the object is read, when which incarnation is meant is not yet known. */
it("keeps every event by name until the object itself is read", async () => {
  const result = mount(null);
  await waitFor(() => expect(result.current.data).toBeDefined());
  expect(result.current.data).toHaveLength(4);
});

/**
 * The kubelet writes a Node's name where its uid belongs. Read as a uid, every
 * kubelet event left a Node's Events tab once the node was read. Fails if the
 * name is compared with the node's uid.
 */
it("keeps an event that names its object by name where the uid belongs", () => {
  const kubelet: EventInfo = {
    ...event("NodeReady", "node-1"),
    involvedObject: {
      kind: "Node",
      name: "node-1",
      namespace: null,
      uid: "node-1",
    },
  };
  expect(ofIncarnation([kubelet], "a1b2-real-uid")).toEqual([kubelet]);
});

/** A page that reads its object outside the shared entry passes the uid itself; fails if that uid is ignored. */
it("filters by a uid its caller read itself", async () => {
  const client = testQueryClient();
  const { result } = renderHook(
    () =>
      useObjectEvents("Pod", "wd-demo", "lena-sandbox", {
        refresh: "slow",
        uid: "current",
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    }
  );
  await waitFor(() => expect(result.current.data).toBeDefined());
  expect(result.current.data?.map((e) => e.reason)).toEqual([
    "Started",
    "Noted",
  ]);
});

/**
 * A ServiceAccount or an HPA peek is read from its manifest, under a key of
 * its own, where the uid sits in `metadata`. Fails if the peek's read is not
 * where the uid is looked for, or the manifest's shape is not read.
 */
it("filters by the uid of an object read from its manifest", async () => {
  const client = testQueryClient();
  const key = ["peek", "Pod", "lena-sandbox", "wd-demo"];
  client.setQueryData(key, { metadata: { uid: "current" } });
  const { result } = renderHook(
    () =>
      useObjectEvents("Pod", "wd-demo", "lena-sandbox", {
        refresh: "slow",
        uid: useReadUidAt(key),
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    }
  );
  await waitFor(() => expect(result.current.data).toBeDefined());
  expect(result.current.data?.map((e) => e.reason)).toEqual([
    "Started",
    "Noted",
  ]);
});

const at = (second: number) =>
  new Date(Date.UTC(2026, 9, 15, 10, 0, second)).toISOString();

const onObject = (
  kind: string,
  name: string,
  uid: string,
  reason: string,
  second: number
): EventInfo => ({
  ...event(reason, uid),
  name: `${name}.${reason}`,
  uid: `event-${name}-${reason}`,
  type: kind === "ReplicaSet" ? "Warning" : "Normal",
  involvedObject: { kind, name, namespace: "lena-sandbox", uid },
  lastTimestamp: at(second),
});

function mountDeployment() {
  const client = testQueryClient();
  const { result } = renderHook(
    () =>
      useObjectEvents("Deployment", "web", "lena-sandbox", {
        refresh: "slow",
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    }
  );
  return result;
}

/**
 * Live, capped's Events tab said 0 while its ReplicaSet held 73 FailedCreate
 * events. Fails if a Deployment's events leave out its own ReplicaSets'
 * warnings, take another Deployment's, or lose the newest-first order.
 */
it("carries the warnings of a Deployment's own ReplicaSets, newest first", async () => {
  answer.events = [
    onObject("Deployment", "web", "deploy", "ScalingReplicaSet", 1),
  ];
  answer.sets = [{ uid: "rs-web", name: "web-7d9f" }];
  answer.setEvents = [
    onObject("ReplicaSet", "web-7d9f", "rs-web", "FailedCreate", 5),
    onObject("ReplicaSet", "web-api-6c4b", "rs-other", "FailedCreate", 9),
  ];
  const result = mountDeployment();
  await waitFor(() => expect(result.current.data).toHaveLength(2));
  expect(
    result.current.data?.map((e) => `${e.involvedObject.name} ${e.reason}`)
  ).toEqual(["web-7d9f FailedCreate", "web ScalingReplicaSet"]);
  expect(result.current.ownedUnread).toBeNull();
});

/**
 * Fails if a ReplicaSet list that could not be read is taken for one with no
 * warnings: the tab would say the Deployment's own events are all there is.
 */
it("says its ReplicaSets' warnings could not be read rather than that there are none", async () => {
  answer.events = [
    onObject("Deployment", "web", "deploy", "ScalingReplicaSet", 1),
  ];
  answer.sets = new Error("replicasets.apps is forbidden");
  const result = mountDeployment();
  await waitFor(() => expect(result.current.ownedUnread).not.toBeNull());
  expect(result.current.ownedUnread?.unread).toBe("replicaSetWarningsUnread");
  expect(result.current.data?.map((e) => e.reason)).toEqual([
    "ScalingReplicaSet",
  ]);
  answer.sets = [];
});
