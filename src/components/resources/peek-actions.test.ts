import { describe, expect, it, vi } from "vitest";

// The plan never calls a command; it only needs the module to load.
vi.mock("@/lib/commands", () => ({ commands: {} }));

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { ContainerState, PodInfo, ServiceInfo } from "@/generated/types";
import {
  describeBareRestart,
  describeDeletion,
  peekMutationKeys,
  planPeekActions,
  scaleCommandFor,
  type PeekAction,
} from "./peek-actions";
import { SCALABLE_KINDS } from "@/lib/resource-registry";

function container(
  name: string,
  state: ContainerState,
  ports: number[] = []
): PodInfo["containers"][number] {
  return {
    name,
    image: "busybox:1.36",
    ready: state.type === "running",
    started: state.type === "running",
    phase: "app",
    state,
    lastTerminated: null,
    restartCount: 0,
    ports: ports.map((containerPort) => ({
      name: null,
      containerPort,
      protocol: "TCP",
    })),
    env: [],
    envFrom: [],
  };
}

function pod(overrides: Partial<PodInfo> = {}): PodInfo {
  return {
    name: "log-demo-1",
    namespace: "k8s-gui-test",
    uid: "pod-uid",
    status: {
      phase: "Running",
      display: "Running",
      ready: true,
      conditions: [],
      message: null,
      reason: null,
    },
    nodeName: "k3d-agent-0",
    podIp: "10.42.0.46",
    hostIp: "172.18.0.3",
    containers: [container("app", { type: "running" }, [8080])],
    labels: {},
    annotations: {},
    createdAt: "2026-08-05T00:00:00Z",
    restartCount: 0,
    lastRestartAt: null,
    cpuRequests: null,
    cpuLimits: null,
    memoryRequests: null,
    memoryLimits: null,
    ownerReferences: [
      {
        api_version: "apps/v1",
        kind: "ReplicaSet",
        name: "log-demo-6cf",
        uid: "rs-uid",
        controller: true,
      },
    ],
    ...overrides,
  } as PodInfo;
}

const labels = (actions: PeekAction[]) => actions.map((action) => action.label);
const find = (actions: PeekAction[], id: string) =>
  actions.find((action) => action.id === id);
/** The English catalogue, which is what these expectations are written in. */
const t: T = (section, key, values) => translate("en", section, key, values);

const all = (kind: string, detail?: unknown, context = {}) => {
  const plan = planPeekActions(kind, detail, t, context);
  return [...plan.inline, ...plan.menu];
};

describe("planPeekActions", () => {
  it("keeps the two most-used pod actions in the row and folds the rest away", () => {
    const plan = planPeekActions("Pod", pod(), t);
    expect(labels(plan.inline)).toEqual(["Shell", "Port forward"]);
    expect(labels(plan.menu)).toEqual(["Debug", "Restart", "Delete"]);
  });

  // Five controls or fewer and there is nothing to hide behind.
  it("leaves a short row whole", () => {
    const plan = planPeekActions("Deployment", undefined, t);
    expect(labels(plan.inline)).toEqual(["Scale", "Restart", "Delete"]);
    expect(plan.menu).toEqual([]);
  });

  it("offers a plain Delete for a kind with nothing else to do", () => {
    expect(labels(all("ConfigMap"))).toEqual(["Delete"]);
    expect(labels(all("DaemonSet"))).toEqual(["Delete"]);
  });

  // The trap this guards is a control on one surface and not the other: a
  // kind the detail page can scale and the peek cannot, or the reverse. Both
  // read `SCALABLE_KINDS`, so the list itself is what is asserted here.
  it("offers Scale for every kind this app can scale, and no other", () => {
    expect([...SCALABLE_KINDS]).toEqual(["Deployment", "StatefulSet"]);
    for (const kind of SCALABLE_KINDS) {
      expect(find(all(kind), "scale")).toBeDefined();
      expect(scaleCommandFor(kind)).toBeTypeOf("function");
    }
    // A ReplicaSet is scalable through the API and deliberately is not here:
    // the Deployment above it puts the number back on the same watch event.
    expect(find(all("ReplicaSet"), "scale")).toBeUndefined();
    expect(scaleCommandFor("ReplicaSet")).toBeNull();
    expect(find(all("DaemonSet"), "scale")).toBeUndefined();
  });

  // No delete command exists for a node, and inventing one from the peek is
  // not how anyone should meet that behaviour for the first time.
  it("offers a node only what its page offers", () => {
    expect(labels(all("Node"))).toEqual(["Debug node"]);
  });

  it("says nothing about an unknown kind", () => {
    expect(all("Wobble")).toEqual([]);
  });
});

describe("why a pod action cannot run", () => {
  const pending = pod({
    name: "unschedulable-demo",
    status: {
      phase: "Pending",
      display: "Pending",
      ready: false,
      conditions: [],
      message: "0/3 nodes are available: insufficient cpu.",
      reason: "Unschedulable",
    },
    containers: [
      container(
        "app",
        { type: "waiting", reason: "ContainerCreating" },
        [8080]
      ),
    ],
  } as Partial<PodInfo>);

  it("will not offer a shell into a pod that has not started", () => {
    const actions = all("Pod", pending);
    expect(find(actions, "shell")?.reason).toMatch(
      /No container is running yet — this pod is Pending · app ContainerCreating/
    );
  });

  it("will not forward a port nothing is listening on", () => {
    expect(find(all("Pod", pending), "portForward")?.reason).toMatch(
      /Nothing is listening yet/
    );
  });

  it("says a finished pod has nothing left to attach to", () => {
    const done = pod({
      status: {
        phase: "Succeeded",
        display: "Completed",
        ready: false,
        conditions: [],
        message: null,
        reason: null,
      },
      containers: [
        container("app", {
          type: "terminated",
          termination: {
            exitCode: 0,
            signal: null,
            reason: null,
            message: null,
            startedAt: null,
            finishedAt: null,
          },
        }),
      ],
    } as Partial<PodInfo>);
    expect(find(all("Pod", done), "shell")?.reason).toMatch(
      /has finished — Succeeded/
    );
  });

  it("says when there is no port declared to forward at all", () => {
    const portless = pod({
      containers: [container("app", { type: "running" })],
    });
    expect(find(all("Pod", portless), "portForward")?.reason).toMatch(
      /declares a port/
    );
    // Running and reachable, so the shell is still on offer.
    expect(find(all("Pod", portless), "shell")?.reason).toBeUndefined();
  });

  it("leaves a healthy pod's actions alone", () => {
    for (const action of all("Pod", pod())) {
      expect(action.reason).toBeUndefined();
    }
  });
});

describe("restarting a pod nothing owns", () => {
  const bare = pod({ name: "bare-demo", ownerReferences: [] });

  // Deleting a pod under a Deployment is a restart. Deleting one under
  // nothing is a deletion, and the word has to change with the meaning.
  it("does not call it the same thing a controller's restart is called", () => {
    expect(find(all("Pod", bare), "restart")).toMatchObject({
      label: "Restart (deletes it)",
      danger: true,
    });
    expect(find(all("Pod", pod()), "restart")).toMatchObject({
      label: "Restart",
    });
    expect(find(all("Pod", pod()), "restart")?.danger).toBeUndefined();
  });

  it("spells out that nothing will bring it back", () => {
    expect(describeBareRestart("bare-demo", "k8s-gui-test", t)).toMatchObject({
      title: "Restart pod k8s-gui-test/bare-demo?",
      description: expect.stringContaining("nothing will recreate it"),
    });
  });
});

describe("a Service's port forward", () => {
  const service = (ports: number[]): ServiceInfo =>
    ({
      name: "web",
      namespace: "k8s-gui-test",
      uid: "svc-uid",
      type: "ClusterIP",
      sessionAffinity: "None",
      clusterIp: "10.43.0.7",
      externalIps: [],
      loadBalancerIps: [],
      ports: ports.map((port) => ({
        name: null,
        port,
        targetPort: String(port),
        nodePort: null,
        protocol: "TCP",
      })),
      selector: { app: "web" },
      labels: {},
      annotations: {},
      createdAt: null,
    }) as ServiceInfo;

  it("has nothing to forward when the Service declares no port", () => {
    expect(find(all("Service", service([])), "portForward")?.reason).toMatch(
      /declares no ports/
    );
  });

  it("says so when nothing is behind the Service", () => {
    const actions = all("Service", service([80]), { backend: null });
    expect(find(actions, "portForward")?.reason).toMatch(/No ready endpoints/);
  });

  it("stays quiet while the endpoints are still being read", () => {
    const actions = all("Service", service([80]), {
      backend: null,
      backendPending: true,
    });
    expect(find(actions, "portForward")?.reason).toBeUndefined();
  });

  it("repeats the refusal rather than guessing when endpoints cannot be read", () => {
    const actions = all("Service", service([80]), {
      backendError: "endpoints is forbidden",
    });
    expect(find(actions, "portForward")?.reason).toMatch(
      /endpoints is forbidden/
    );
  });

  it("is on offer once a pod behind it is known", () => {
    const actions = all("Service", service([80]), {
      backend: { podName: "web-abc", port: 8080 },
    });
    expect(find(actions, "portForward")?.reason).toBeUndefined();
  });
});

describe("describeDeletion", () => {
  it("names the object and what goes with it", () => {
    expect(
      describeDeletion("Pod", "log-demo-1", "k8s-gui-test", pod(), t)
    ).toMatchObject({
      title: "Delete pod k8s-gui-test/log-demo-1?",
      description: expect.stringContaining("ReplicaSet log-demo-6cf"),
    });
  });

  it("warns that a pod nobody owns does not come back", () => {
    const copy = describeDeletion(
      "Pod",
      "bare-demo",
      "k8s-gui-test",
      pod({ ownerReferences: [] }),
      t
    );
    expect(copy.description).toContain("nothing will bring it back");
  });

  it("counts the pods a Deployment takes with it", () => {
    const copy = describeDeletion(
      "Deployment",
      "web",
      "k8s-gui-test",
      {
        replicas: { desired: 3, ready: 3, updated: 3, available: 3 },
      },
      t
    );
    expect(copy.description).toContain("3 pods");
  });

  it("drops the namespace for a cluster-scoped object", () => {
    expect(
      describeDeletion("PersistentVolume", "pv-1", null, {}, t).title
    ).toBe("Delete persistentvolume pv-1?");
  });
});

describe("peekMutationKeys", () => {
  // The lists are plural-first, the detail pages singular-first. A mutation
  // has to reach both or the row behind the panel keeps its old state.
  it("covers both key shapes in the app", () => {
    const keys = peekMutationKeys("Pod").map((key) => key.join("/"));
    expect(keys).toContain("pods");
    expect(keys).toContain("pod");
    expect(keys).toContain("peek");
  });
});
