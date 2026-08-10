import { describe, expect, it } from "vitest";

import {
  chainSilence,
  connectionGroups,
  describeStop,
  describeUsages,
  trafficChains,
} from "./connections";
import type {
  ChainStop,
  PublishedEndpoint,
  ServicePublished,
  ConnectionEdge,
  ObjectFacts,
  ObjectRef,
  ResourceConnections,
  Usage,
} from "@/generated/types";

const ref = (
  kind: string,
  name: string,
  facts: ObjectFacts | null = null,
  existence: ObjectRef["existence"] = "present"
): ObjectRef => ({
  kind,
  name,
  namespace: "k8s-gui-test",
  existence,
  facts,
});

const pod = (name: string, ready: boolean): ObjectRef =>
  ref("Pod", name, {
    kind: "pod",
    phase: "Running",
    display: ready ? "Running" : "NotReady",
    ready,
  });

const service = (name: string, selector: string | null): ObjectRef =>
  ref("Service", name, {
    kind: "service",
    type: "ClusterIP",
    clusterIp: "10.43.0.9",
    externalName: null,
    selector,
    ports: [
      {
        name: null,
        port: 80,
        targetPort: "8080",
        nodePort: null,
        protocol: "TCP",
      },
    ],
  });

const connections = (
  subject: ObjectRef,
  edges: ConnectionEdge[],
  stops: ChainStop[] = [],
  notLookedAt: ResourceConnections["notLookedAt"] = [],
  published: ServicePublished[] = []
): ResourceConnections => ({
  subject,
  edges,
  stops,
  published,
  notLookedAt,
});

/** What a Service publishes, as its slices state it. */
const publishes = (
  name: string,
  counts: Partial<
    Pick<ServicePublished, "ready" | "draining" | "notReady" | "unrouted">
  >,
  extra: Partial<ServicePublished> = {}
): ServicePublished => ({
  service: {
    kind: "Service",
    name,
    namespace: "k8s-gui-test",
    existence: "present",
    facts: null,
  },
  source: "slices",
  slices: 1,
  ready: 0,
  draining: 0,
  notReady: 0,
  unrouted: 0,
  ports: [],
  endpoints: [],
  whole: true,
  unpublished: [],
  ...counts,
  ...extra,
});

const endpointOf = (pod: string, state: Partial<PublishedEndpoint> = {}) => ({
  address: "10.42.1.51",
  target: {
    kind: "Pod",
    name: pod,
    namespace: "k8s-gui-test",
    existence: "present" as const,
    facts: null,
  },
  ready: true,
  serving: true,
  terminating: false,
  nodeName: "server-0",
  zone: null,
  hintZones: [],
  ports: [8080],
  ...state,
});

describe("the traffic chain", () => {
  it("draws a Service in front of a workload as a hop, and the pods behind it", () => {
    /** The whole point of the view: a Deployment cannot say today whether
     *  anything fronts it. If the Service edge stops becoming a hop, the
     *  Overview goes back to showing an unreachable workload as fine. */
    const deployment = ref("Deployment", "log-demo");
    const svc = service("log-demo", "app=log-demo");
    const path = trafficChains(
      connections(
        deployment,
        [
          {
            from: svc,
            to: deployment,
            relation: { verb: "selects", selector: "app=log-demo" },
          },
        ],
        [],
        [],
        [
          publishes(
            "log-demo",
            { ready: 2 },
            { endpoints: [endpointOf("log-demo-a"), endpointOf("log-demo-b")] }
          ),
        ]
      )
    )[0];

    expect(path.hops.map((hop) => hop.at)).toEqual([
      "object",
      "object",
      "published",
    ]);
    expect(path.broken).toBe(false);
    const svcHop = path.hops[0];
    if (svcHop.at !== "object") throw new Error("expected the Service hop");
    expect(svcHop.detail).toBe(":80 → 8080");
    expect(svcHop.via).toContain("selects app=log-demo");
    const last = path.hops[2];
    if (last.at !== "published") throw new Error("expected the published hop");
    expect(last.summary).toBe("and 1 more · 2 published");
  });

  it("puts an Ingress above the Service that routes to it", () => {
    /** The hop the reader came for. Losing it turns "how does traffic get
     *  here" back into a visit to the Ingress list page. */
    const deployment = ref("Deployment", "log-demo");
    const svc = service("log-demo", "app=log-demo");
    const ingress = ref("Ingress", "log-demo", {
      kind: "ingress",
      className: "nginx",
    });
    const path = trafficChains(
      connections(deployment, [
        {
          from: svc,
          to: deployment,
          relation: { verb: "selects", selector: "app=log-demo" },
        },
        {
          from: svc,
          to: pod("log-demo-a", true),
          relation: { verb: "selects", selector: "app=log-demo" },
        },
        {
          from: ingress,
          to: svc,
          relation: {
            verb: "routes",
            host: "log-demo.local",
            path: "/",
            pathType: "Prefix",
            port: "80",
            tls: false,
          },
        },
      ])
    )[0];

    const hop = path.hops[0];
    if (hop.at !== "object") throw new Error("expected the Ingress hop");
    expect(hop.object.kind).toBe("Ingress");
    expect(hop.detail).toBe("log-demo.local/");
    expect(hop.via).toBe("over plain HTTP · nginx");
  });

  it("marks a chain that stops, and says which pods are not ready", () => {
    /** `noneReady` is the case every list page in the app draws as healthy.
     *  If it stops arriving as a hop of its own, the one screen that could
     *  have said so goes quiet too. */
    const svc = service("unready-demo", "app=unready-demo");
    const path = trafficChains(
      connections(
        svc,
        [
          {
            from: svc,
            to: pod("unready-demo-a", false),
            relation: { verb: "selects", selector: "app=unready-demo" },
          },
          {
            from: svc,
            to: pod("unready-demo-b", false),
            relation: { verb: "selects", selector: "app=unready-demo" },
          },
        ],
        [
          {
            reason: "noneReady",
            service: svc,
            selector: "app=unready-demo",
            pods: 2,
          },
        ]
      )
    )[0];

    expect(path.broken).toBe(true);
    const stop = path.hops[path.hops.length - 1];
    if (stop.at !== "stop") throw new Error("expected a stop hop");
    expect(stop.title).toBe(
      "2 pods carry app=unready-demo, and none of them is ready"
    );
  });

  it("says the three stops differently", () => {
    /** Three stops, three repairs. Collapsing them into one sentence is the
     *  difference between a tool and a red dot. */
    const svc = service("demo", "app=demo");
    const titles = (
      [
        {
          reason: "backendMissing",
          ingress: ref("Ingress", "ghost-demo"),
          service: svc,
        },
        { reason: "selectsNothing", service: svc, selector: "app=tls-demo" },
        { reason: "noneReady", service: svc, selector: "app=x", pods: 2 },
      ] satisfies ChainStop[]
    ).map((stop) => describeStop(stop).title);

    expect(new Set(titles).size).toBe(3);
    expect(titles[0]).toContain("No Service named demo");
    expect(titles[1]).toBe("No pod carries app=tls-demo");
  });

  it("costs one line when nothing fronts the workload", () => {
    /** A Deployment with no Service must not pay for a diagram to say so.
     *  A chain drawn from a single hop would be a rail and a dot saying
     *  what one sentence says. */
    const deployment = ref("Deployment", "quiet-demo");
    const conns = connections(deployment, [
      {
        from: deployment,
        to: pod("quiet-demo-a", true),
        relation: { verb: "selects", selector: "app=quiet-demo" },
      },
    ]);

    expect(trafficChains(conns)).toEqual([]);
    expect(chainSilence(conns)).toContain("No Service in this namespace");
  });

  it("says an ExternalName resolves elsewhere rather than drawing an empty chain", () => {
    /** A Service with no selector is not a broken one, and calling it a stop
     *  would be an accusation the cluster never made. */
    const svc = ref("Service", "external-demo", {
      kind: "service",
      type: "ExternalName",
      clusterIp: null,
      externalName: "example.com",
      selector: null,
      ports: [],
    });
    const conns = connections(svc, []);

    expect(trafficChains(conns)).toEqual([]);
    expect(chainSilence(conns)).toContain("example.com");
  });
});

describe("the groups", () => {
  const mount: Usage = {
    how: "mount",
    container: "app",
    path: "/etc/app",
    readOnly: false,
    subPath: null,
    volume: "config",
    projected: false,
  };
  const env: Usage = {
    how: "env",
    container: "app",
    name: "APP_MESSAGE",
    key: "app.conf",
  };

  it("phrases a usage from what the backend sent, not from the pod spec", () => {
    /** `Usage` carries the path and the key. Rebuilding "mounted at /etc/app"
     *  from a volume list is how the two spellings drift apart. */
    expect(describeUsages([mount, env])).toEqual([
      "mounted at /etc/app, and APP_MESSAGE reads app.conf",
    ]);
  });

  it("breaks a pile of usages into lines and names the containers", () => {
    /** A ConfigMap mounted by two containers at the same path, read as an
     *  environment variable and imported wholesale is five clauses in one
     *  sentence. Lines make it readable — and the two containers mounting
     *  one path share a line rather than printing that path twice. */
    expect(
      describeUsages([
        mount,
        { ...mount, container: "seed" },
        env,
        { how: "envFrom", container: "app" },
      ])
    ).toEqual([
      "app, seed · mounted at /etc/app",
      "app · APP_MESSAGE reads app.conf",
      "app · every key becomes an environment variable",
    ]);
  });

  it("says one mount once, however many containers make it", () => {
    /** The service-account volume, which every container of every pod in
     *  the cluster mounts read-only at the longest path in Kubernetes. One
     *  line per container printed that path once per container, and the
     *  containers are left off a line no other line contends with. */
    expect(
      describeUsages([
        { ...mount, container: "ingest", projected: true, readOnly: true },
        { ...mount, container: "web", projected: true, readOnly: true },
      ])
    ).toEqual(["projected into /etc/app, read-only"]);
  });

  it("keeps two mounts of one path apart where they differ", () => {
    /** An init container that writes what the app container only reads is
     *  two mounts, not one: grouping keys on what the line says, so the
     *  read-only flag splits them and the containers say which is which. */
    expect(
      describeUsages([
        { ...mount, container: "seed" },
        { ...mount, readOnly: true },
      ])
    ).toEqual([
      "seed · mounted at /etc/app",
      "app · mounted at /etc/app, read-only",
    ]);
  });

  it("asks what this needs to run rather than listing kinds", () => {
    /** Grouping by kind is the pile this replaces: a ConfigMap and a claim
     *  are both "needs to run", under the two different labels a reader
     *  would look for them by. */
    const deployment = ref("Deployment", "mounts-demo");
    const groups = connectionGroups(
      connections(deployment, [
        {
          from: deployment,
          to: ref("ConfigMap", "demo-config", null, "notChecked"),
          relation: { verb: "uses", usages: [mount, env] },
        },
        {
          from: deployment,
          to: ref("PersistentVolumeClaim", "pvc-demo", {
            kind: "claim",
            phase: "Bound",
            capacity: "1Gi",
            storageClass: "local-path",
          }),
          relation: {
            verb: "uses",
            usages: [{ ...mount, path: "/var/lib/data" }],
          },
        },
      ])
    );

    const needs = groups.find((group) => group.key === "needs");
    expect(needs?.rows.map((row) => row.label)).toEqual([
      "Configuration",
      "Storage",
    ]);
    expect(needs?.rows[1].ways).toEqual(["mounted at /var/lib/data"]);
    expect(needs?.rows[1].detail).toBe("1Gi · local-path · Bound");
  });

  it("names the kinds nobody asked about", () => {
    /** An empty group that is simply not drawn tells the reader "there is no
     *  HPA on this Deployment" — a claim the app cannot make, because it
     *  never asked. */
    const groups = connectionGroups(
      connections(
        ref("Deployment", "log-demo"),
        [],
        [],
        [
          {
            kind: "HorizontalPodAutoscaler",
            why: "the app does not read HorizontalPodAutoscalers, so it cannot say whether one scales this",
          },
        ]
      )
    );

    const unasked = groups.find((group) => group.key === "unasked");
    expect(unasked?.rows).toHaveLength(1);
    expect(unasked?.rows[0].label).toBe("Autoscaling");
    expect(unasked?.rows[0].unasked).toBe(true);
  });
});

describe("what the Service publishes", () => {
  /**
   * The defect this replaced. A pod draining is `serving: true, ready: false`
   * and is exactly the address kube-proxy falls back to when nothing ready is
   * left — so a Service down to one of them is a rolling restart, not an
   * outage. Would break the moment the last hop goes back to counting `Ready`.
   */
  it("reads a draining endpoint as draining rather than as an outage", () => {
    const deployment = ref("Deployment", "draining-demo");
    const svc = service("draining-demo", "app=draining-demo");
    const path = trafficChains(
      connections(
        deployment,
        [
          {
            from: svc,
            to: deployment,
            relation: { verb: "selects", selector: "app=draining-demo" },
          },
        ],
        [],
        [],
        [
          publishes(
            "draining-demo",
            { ready: 0, draining: 1 },
            {
              endpoints: [
                endpointOf("draining-demo-a", {
                  ready: false,
                  serving: true,
                  terminating: true,
                }),
              ],
            }
          ),
        ]
      )
    )[0];

    expect(path.broken).toBe(false);
    const last = path.hops[path.hops.length - 1];
    if (last.at !== "published") throw new Error("expected the published hop");
    expect(last.tone).toBe("warn");
    expect(last.summary).toContain("1 draining");
    expect(last.summary).toContain("still taking traffic");
    expect(last.summary).not.toContain("not ready");
  });

  /**
   * The case worth building the whole thing for: a healthy selector, healthy
   * pods, a green everything, and no traffic. The reason is derived from two
   * things the app already holds — the `targetPort` the Service asks for and
   * the port names the containers declare — so it is named rather than left
   * as "it does not work".
   */
  it("names the port a Service asks for that no container declares", () => {
    const said = describeStop({
      reason: "publishesNothing",
      service: service("named-port-demo", "app=named-port-demo"),
      selector: "app=named-port-demo",
      pods: 2,
      readyPods: 2,
      unnamedPorts: ["http"],
    });

    expect(said.title).toBe("This Service publishes no endpoint");
    expect(said.note).toContain("2 pods match its selector");
    expect(said.note).toContain("all of them are Ready");
    expect(said.note).toContain("targetPort: http");
    expect(said.note).toContain("Name the port in the container");
  });

  /** And it declines to explain what it cannot see. A pod missing from every
   *  slice for a reason nothing states gets no invented cause. */
  it("says only what it holds when the reason is not derivable", () => {
    const said = describeStop({
      reason: "publishesNothing",
      service: service("mystery", "app=mystery"),
      selector: "app=mystery",
      pods: 1,
      readyPods: 1,
      unnamedPorts: [],
    });

    expect(said.note).toContain("not something these objects state");
    expect(said.note).not.toContain("targetPort");
  });

  /**
   * The app reads EndpointSlices now, so nothing may name them as unread. A
   * page saying "the app does not look at this" beside a list drawn from it
   * is worse than the gap it replaced.
   */
  it("never names EndpointSlice as a kind it did not look at", () => {
    const groups = connectionGroups(
      connections(
        ref("Service", "log-demo"),
        [],
        [],
        [
          {
            kind: "EndpointSlice",
            why: "readiness here is each pod's own Ready condition",
          },
        ]
      )
    );

    const unasked = groups.find((group) => group.key === "unasked");
    expect(unasked?.rows.map((row) => row.label)).not.toContain("Endpoints");
    expect(unasked?.rows[0].label).toBe("EndpointSlice");
  });
});
