import { describe, expect, it } from "vite-plus/test";

import { decide, type Exists, type Reader, type Target } from "./attached";

/** A cluster where each named object answers as `exists` says. */
function reader(
  exists: Record<string, Exists>,
  siblings: Array<Record<string, unknown>> | null = []
): Reader {
  return {
    exists: async (target: Target) =>
      exists[`${target.kind}/${target.name}`] ?? "missing",
    siblings: async () => siblings,
    refOf: (target: Target) => ({
      kind: target.kind,
      name: target.name,
      namespace: target.namespace ?? null,
    }),
  };
}

const hpa = (name: string, target = "api") => ({
  metadata: { name, namespace: "shop" },
  spec: {
    scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: target },
  },
});

describe("an autoscaler", () => {
  it("opens on the workload it scales when it is the only one there", async () => {
    expect(
      await decide(
        "horizontalpodautoscalers",
        hpa("api"),
        reader({ "Deployment/api": "present" }, [hpa("api")])
      )
    ).toEqual({
      state: "parent",
      parent: { kind: "Deployment", name: "api", namespace: "shop" },
    });
  });

  /**
   * "Does not exist" and "could not read" are two claims. A refused read
   * that came out as the first would tell someone their workload is gone.
   */
  it("says its target could not be read, not that it is missing", async () => {
    const answer = await decide(
      "horizontalpodautoscalers",
      hpa("api"),
      reader({ "Deployment/api": { unread: "deployments is forbidden" } })
    );
    expect(answer).toEqual({
      state: "stay",
      stay: {
        says: "targetUnread",
        kind: "Deployment",
        name: "api",
        error: "deployments is forbidden",
      },
    });
  });

  it("says its target does not exist when the read found nothing", async () => {
    const answer = await decide(
      "horizontalpodautoscalers",
      hpa("api"),
      reader({})
    );
    expect(answer).toMatchObject({ stay: { says: "targetMissing" } });
  });

  /** Two autoscalers on one workload fight; opening either on it hides that. */
  it("stays on its own page when another autoscaler aims at the same target", async () => {
    const answer = await decide(
      "horizontalpodautoscalers",
      hpa("api"),
      reader({ "Deployment/api": "present" }, [hpa("api"), hpa("api-2")])
    );
    expect(answer).toMatchObject({ stay: { says: "targetContested" } });
  });

  /** Siblings nobody could read are not siblings that are absent. */
  it("stays when whether it is alone could not be checked", async () => {
    const answer = await decide(
      "horizontalpodautoscalers",
      hpa("api"),
      reader({ "Deployment/api": "present" }, null)
    );
    expect(answer).toMatchObject({ stay: { says: "siblingsUnread" } });
  });
});

describe("endpoints", () => {
  const endpoints = { metadata: { name: "web", namespace: "shop" } };

  it("open on their Service's endpoints tab", async () => {
    expect(
      await decide("endpoints", endpoints, reader({ "Service/web": "present" }))
    ).toMatchObject({ state: "parent", tab: "endpoints" });
  });

  it("stay where no Service keeps them", async () => {
    expect(await decide("endpoints", endpoints, reader({}))).toEqual({
      state: "stay",
      stay: { says: "noService", name: "web" },
    });
  });

  it("follow a slice to its Service by the label it carries", async () => {
    const slice = {
      metadata: {
        name: "web-x7k2p",
        namespace: "shop",
        labels: { "kubernetes.io/service-name": "web" },
      },
    };
    expect(
      await decide(
        "endpointslices.discovery.k8s.io",
        slice,
        reader({ "Service/web": "present" })
      )
    ).toMatchObject({ state: "parent", parent: { name: "web" } });
  });
});

describe("the other attached kinds", () => {
  it("open a revision on its owner's history", async () => {
    const revision = {
      metadata: {
        name: "db-5d8f",
        namespace: "shop",
        ownerReferences: [
          {
            apiVersion: "apps/v1",
            kind: "StatefulSet",
            name: "db",
            controller: true,
          },
        ],
      },
    };
    expect(
      await decide(
        "controllerrevisions.apps",
        revision,
        reader({ "StatefulSet/db": "present" })
      )
    ).toMatchObject({ state: "parent", tab: "changes" });
  });

  it("keep a revision nothing owns on its own page", async () => {
    expect(
      await decide(
        "controllerrevisions.apps",
        { metadata: { name: "x", namespace: "shop" } },
        reader({})
      )
    ).toEqual({ state: "stay", stay: { says: "noOwner" } });
  });

  /** A Pod's page has no events tab to open on, so its event is not moved. */
  it("open an event only on a page that has an events tab", async () => {
    const about = (kind: string) => ({
      metadata: { name: "e", namespace: "shop" },
      involvedObject: { kind, name: "x", namespace: "shop" },
    });
    expect(
      await decide(
        "events",
        about("Ingress"),
        reader({ "Ingress/x": "present" })
      )
    ).toMatchObject({ state: "parent", tab: "events" });
    expect(
      await decide("events", about("Pod"), reader({ "Pod/x": "present" }))
    ).toEqual({ state: "free" });
  });

  it("open a node's heartbeat on the node, and leave other leases alone", async () => {
    const lease = (namespace: string) => ({
      metadata: { name: "node-1", namespace },
    });
    expect(
      await decide(
        "leases.coordination.k8s.io",
        lease("kube-node-lease"),
        reader({ "Node/node-1": "present" })
      )
    ).toMatchObject({ state: "parent", parent: { kind: "Node" } });
    expect(
      await decide(
        "leases.coordination.k8s.io",
        lease("kube-system"),
        reader({})
      )
    ).toEqual({ state: "free" });
  });
});
