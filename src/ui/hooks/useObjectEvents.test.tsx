import { beforeEach, expect, it, vi } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const answer = vi.hoisted(() => ({
  asked: [] as unknown[],
  events: [] as unknown[],
  setEvents: [] as unknown[],
  sets: [] as unknown[] | Error,
  jobEvents: [] as unknown[],
  jobs: [] as unknown[],
  short: false,
}));
vi.mock("@/lib/commands", () => ({
  commands: {
    listEvents: (filters: { involved_object_kind: string | null }) => {
      answer.asked.push(filters);
      return Promise.resolve(
        filters.involved_object_kind === "ReplicaSet"
          ? answer.setEvents
          : filters.involved_object_kind === "Job"
            ? answer.jobEvents
            : answer.events
      );
    },
    listLatestEvents: (filters: unknown) => {
      answer.asked.push(filters);
      return Promise.resolve({ events: answer.events, short: answer.short });
    },
    listJobs: () => Promise.resolve(answer.jobs),
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
import {
  eventsKindOf,
  ofObject,
  useObjectEvents,
  type EventsKind,
} from "./useObjectEvents";
import { useReadEventsUidAt, useReadUidAt } from "./useReadUid";

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

function mount(
  read: { uid: string; annotations?: Record<string, string> } | null
) {
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

/**
 * etcd on a kind control plane: the kubelet records a static pod's events
 * under the hash in its mirror annotation, and the page said "No events for
 * this object". Fails if they are matched against the mirror's own uid.
 */
it("keeps a static pod's events, which carry the hash in its mirror annotation", async () => {
  const result = mount({
    uid: "9f0c2a11",
    annotations: { "kubernetes.io/config.mirror": "current" },
  });
  await waitFor(() => expect(result.current.data).toBeDefined());
  expect(result.current.data?.map((e) => e.reason)).toEqual([
    "Started",
    "Noted",
  ]);
});

/** The peek reads its object under a key of its own. Fails if that read is matched by the mirror's uid, which empties a static pod's peek. */
it("keeps a static pod's events where the peek's own read holds it", async () => {
  const client = testQueryClient();
  const key = ["peek", "Pod", "lena-sandbox", "wd-demo"];
  client.setQueryData(key, {
    metadata: {
      uid: "9f0c2a11",
      annotations: { "kubernetes.io/config.mirror": "current" },
    },
  });
  const { result } = renderHook(
    () =>
      useObjectEvents("Pod", "wd-demo", "lena-sandbox", {
        refresh: "slow",
        uid: useReadEventsUidAt("Pod", key),
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
  expect(ofObject([kubelet], "", "a1b2-real-uid")).toEqual([kubelet]);
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

const inGroup = (event: EventInfo, apiVersion: string): EventInfo => ({
  ...event,
  involvedObject: { ...event.involvedObject, apiVersion },
});

function mountDeployment(kind: EventsKind = "Deployment", name = "web") {
  const client = testQueryClient();
  const { result } = renderHook(
    () =>
      useObjectEvents(kind, name, "lena-sandbox", {
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

/** A CronJob's refused run is a FailedCreate on the Job; fails if its Events leave out its runs' warnings or take another CronJob's. */
it("carries the warnings of a CronJob's own runs", async () => {
  answer.events = [];
  answer.jobs = [{ uid: "run", name: "nightly-29000000", cronJob: "nightly" }];
  answer.jobEvents = [
    onObject("Job", "nightly-29000000", "run", "FailedCreate", 4),
    onObject("Job", "hourly-29000000", "hourly", "FailedCreate", 6),
  ];
  const result = mountDeployment("CronJob", "nightly");
  await waitFor(() => expect(result.current.data).toHaveLength(1));
  expect(result.current.data?.[0].involvedObject.name).toBe("nightly-29000000");
});

function mountCustom(
  kind: string,
  name: string,
  client = testQueryClient(),
  group: string | null = null
) {
  const { result } = renderHook(
    () =>
      useObjectEvents({ custom: kind, group }, name, "lena-sandbox", {
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
 * A CRD may name its kind Deployment. Fails if such an object's events are
 * narrowed to the uid of the built-in Deployment the cache holds under its
 * name, or carry the warnings of that Deployment's ReplicaSets.
 */
it("reads a custom kind named like a built-in as itself, not as the built-in", async () => {
  const client = testQueryClient();
  client.setQueryData(queryKeys.detail("Deployment", "lena-sandbox", "web"), {
    uid: "deploy",
  });
  answer.events = [onObject("Deployment", "web", "custom", "Reconciled", 2)];
  answer.sets = [{ uid: "rs-web", name: "web-7d9f" }];
  answer.setEvents = [
    onObject("ReplicaSet", "web-7d9f", "rs-web", "FailedCreate", 5),
  ];
  const result = mountCustom("Deployment", "web", client);
  await waitFor(() => expect(result.current.data).toBeDefined());
  expect(result.current.data?.map((e) => e.reason)).toEqual(["Reconciled"]);
  expect(result.current.subject.kind).toBe("Deployment");
});

/** Only the registry's Namespace stands for everything inside it. */
it("reads a custom kind named Namespace as one object, not as every object in a namespace", async () => {
  answer.asked = [];
  answer.events = [];
  const result = mountCustom("Namespace", "team");
  await waitFor(() => expect(result.current.data).toBeDefined());
  expect(result.current.everyObject).toBe(false);
  expect(answer.asked).toEqual([
    expect.objectContaining({
      namespace: "lena-sandbox",
      involved_object_name: "team",
      involved_object_kind: "Namespace",
    }),
  ]);
});

/**
 * A Namespace's Events are those of every object in it, of every group: read
 * by the Namespace's own group, the core one, they lost every Deployment,
 * Job and Ingress event and kept the pods'. Fails if an event is left out of
 * a Namespace's Events for the group its object is served in.
 */
it("keeps the events of every group among those of a Namespace", async () => {
  answer.asked = [];
  answer.events = [
    inGroup(
      onObject("Deployment", "web", "deploy", "ScalingReplicaSet", 3),
      "apps/v1"
    ),
    inGroup(onObject("Pod", "web-7d9f-x2x", "pod", "Started", 2), "v1"),
    inGroup(
      onObject("Ingress", "web", "ing", "Sync", 1),
      "networking.k8s.io/v1"
    ),
  ];
  const client = testQueryClient();
  const { result } = renderHook(
    () =>
      useObjectEvents("Namespace", "lena-sandbox", null, { refresh: "slow" }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    }
  );
  await waitFor(() => expect(result.current.data).toBeDefined());
  expect(result.current.everyObject).toBe(true);
  expect(result.current.short).toBe(false);
  expect(result.current.data?.map((e) => e.reason)).toEqual([
    "ScalingReplicaSet",
    "Started",
    "Sync",
  ]);
});

/**
 * A namespace holding more events than one read walks: the tab said "the
 * latest 200" of the first two thousand in name order, and a warning from a
 * minute ago was not among them. Fails if a namespace's events are read
 * without asking whether the walk reached the end, or the answer is dropped.
 */
it("says where a namespace's events were read short of their end", async () => {
  answer.events = [onObject("Pod", "web-7d9f-x2x", "pod", "Started", 2)];
  answer.short = true;
  const client = testQueryClient();
  const { result } = renderHook(
    () => useObjectEvents("Namespace", "busy", null, { refresh: "slow" }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    }
  );
  await waitFor(() => expect(result.current.data).toHaveLength(1));
  expect(result.current.short).toBe(true);
  answer.short = false;
});

/** The CRD a reference is served by decides, never the kind's name alone. */
it("takes a reference for the registry's kind only where it is that very kind", () => {
  expect(eventsKindOf({ kind: "Service", name: "frontend" })).toBe("Service");
  expect(
    eventsKindOf({
      kind: "Service",
      name: "frontend",
      crd: "services.serving.knative.dev",
    })
  ).toEqual({ custom: "Service", group: "serving.knative.dev" });
  expect(
    eventsKindOf({
      kind: "Application",
      name: "shop",
      crd: "applications.argoproj.io",
    })
  ).toEqual({ custom: "Application", group: "argoproj.io" });
});

/**
 * The group is what tells a namesake's events from the object's own. Fails
 * if a reference whose CRD nobody resolved is given a group it did not
 * name, or a core kind outside the registry is left without its own.
 */
it("names the group a custom reference's events are read by, and none where its CRD is unknown", () => {
  expect(
    eventsKindOf({ kind: "Service", name: "frontend", crd: null })
  ).toEqual({ custom: "Service", group: null });
  expect(eventsKindOf({ kind: "Application", name: "shop" })).toEqual({
    custom: "Application",
    group: null,
  });
  expect(eventsKindOf({ kind: "ServiceAccount", name: "builder" })).toEqual({
    custom: "ServiceAccount",
    group: "",
  });
});

/**
 * The list is asked by the kind's name, which a custom kind may share: a
 * Deployment and a custom Deployment of one name each showed the other's
 * events that carry no uid. Fails if an event naming another group is kept,
 * or one that names no group, which could be either's, is dropped.
 */
it("leaves out the events a namesake kind in another group has under the same name", async () => {
  const own = inGroup(
    onObject("Deployment", "web", "deploy", "ScalingReplicaSet", 3),
    "apps/v1"
  );
  const theirs = {
    ...inGroup(
      onObject("Deployment", "web", "", "Reconciled", 2),
      "apps.example.io/v1"
    ),
    involvedObject: {
      apiVersion: "apps.example.io/v1",
      kind: "Deployment",
      name: "web",
      namespace: "lena-sandbox",
      uid: null,
    },
  };
  const unsaid = {
    ...onObject("Deployment", "web", "", "Noted", 1),
    involvedObject: {
      kind: "Deployment",
      name: "web",
      namespace: "lena-sandbox",
      uid: null,
    },
  };
  answer.events = [own, theirs, unsaid];
  answer.sets = [];
  answer.setEvents = [];

  const builtIn = mountDeployment();
  await waitFor(() => expect(builtIn.current.data).toBeDefined());
  expect(builtIn.current.data?.map((e) => e.reason)).toEqual([
    "ScalingReplicaSet",
    "Noted",
  ]);

  const custom = mountCustom("Deployment", "web", undefined, "apps.example.io");
  await waitFor(() => expect(custom.current.data).toBeDefined());
  expect(custom.current.data?.map((e) => e.reason)).toEqual([
    "Reconciled",
    "Noted",
  ]);
});

/**
 * A controller built against an old API writes `extensions/v1beta1` where the
 * object is served from `apps`, and its events left the object's Events tab,
 * which then said there were none. Fails if an event carrying the object's
 * own uid, or that of a ReplicaSet it owns, is left out for the group it
 * names, or if the uid of another object is let in by its group.
 */
it("keeps an event that carries the object's own uid whatever group it names", async () => {
  const about = (
    kind: string,
    name: string,
    uid: string | null,
    apiVersion: string,
    reason: string,
    second: number
  ): EventInfo => ({
    ...onObject(kind, name, "", reason, second),
    involvedObject: {
      apiVersion,
      kind,
      name,
      namespace: "lena-sandbox",
      uid,
    },
  });
  answer.events = [
    about("Deployment", "web", "deploy", "extensions/v1beta1", "Reloaded", 4),
    about("Deployment", "web", "custom", "apps/v1", "Reconciled", 3),
    about("Deployment", "web", null, "apps.example.io/v1", "Synced", 2),
  ];
  answer.sets = [{ uid: "rs-web", name: "web-7d9f" }];
  answer.setEvents = [
    about(
      "ReplicaSet",
      "web-7d9f",
      "rs-web",
      "extensions/v1beta1",
      "FailedCreate",
      6
    ),
    about("ReplicaSet", "web-7d9f", null, "apps.example.io/v1", "Paused", 5),
  ];
  const client = testQueryClient();
  client.setQueryData(queryKeys.detail("Deployment", "lena-sandbox", "web"), {
    uid: "deploy",
  });
  const { result } = renderHook(
    () =>
      useObjectEvents("Deployment", "web", "lena-sandbox", { refresh: "slow" }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    }
  );
  await waitFor(() => expect(result.current.data).toBeDefined());
  expect(result.current.data?.map((e) => e.reason)).toEqual([
    "FailedCreate",
    "Reloaded",
  ]);
  answer.sets = [];
  answer.setEvents = [];
});

/**
 * A Volcano Job named like a CronJob's run brought its warning to the
 * CronJob's Events. Fails if the warnings of owned objects are matched by
 * name against a kind in another group.
 */
it("leaves a namesake kind's warning out of the warnings of the objects a CronJob owns", async () => {
  const run = (apiVersion: string, reason: string): EventInfo => ({
    ...onObject("Job", "nightly-29000000", "", reason, 4),
    involvedObject: {
      apiVersion,
      kind: "Job",
      name: "nightly-29000000",
      namespace: "lena-sandbox",
      uid: null,
    },
  });
  answer.events = [];
  answer.jobs = [{ uid: "run", name: "nightly-29000000", cronJob: "nightly" }];
  answer.jobEvents = [
    run("batch/v1", "FailedCreate"),
    run("batch.volcano.sh/v1alpha1", "PodGroupPending"),
  ];
  const result = mountDeployment("CronJob", "nightly");
  await waitFor(() => expect(result.current.data).toHaveLength(1));
  expect(result.current.data?.[0].reason).toBe("FailedCreate");
});
