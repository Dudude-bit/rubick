import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type {
  AutoscalerInfo,
  ClusterOverview,
  ClusterProblem,
  IngressHealthInput,
  PersistentVolumeClaimInfo,
  PodCause,
  ServiceHealthGroup,
} from "@/generated/types";
import {
  attentionLines,
  attentionOf,
  checkSaid,
  foldedWords,
  reasonWord,
  type AttentionInputs,
  type GatewayApiInputs,
} from "./attention";
import type { RouteRow } from "./route-rows";
import {
  ingressHealthOf,
  ingressHealthWords,
  type NamespaceBacking,
} from "./ingress-health";
import { serviceHealthOf, serviceHealthWords } from "./service-health";

const t: T = (section, key, values) => translate("en", section, key, values);

const NOW = Date.parse("2026-10-05T12:00:00Z");

function overview(over: Partial<ClusterOverview> = {}): ClusterOverview {
  return {
    problems: [],
    problemsTruncated: 0,
    unconfirmed: [],
    unread: [],
    ...over,
  } as ClusterOverview;
}

function services(
  ...groups: Array<
    [names: string[], ready: number, notReady?: number, type?: string]
  >
): AttentionInputs["services"] {
  return {
    answered: [
      {
        namespace: "net",
        networks: [],
        groups: groups.map(
          ([
            names,
            ready,
            notReady = 0,
            type = "ClusterIP",
          ]): ServiceHealthGroup => ({
            names,
            type,
            selectorless: false,
            targets: [],
            ready,
            draining: 0,
            notReady,
            unrouted: 0,
          })
        ),
      },
    ],
    unread: [],
  };
}

function ingress(name: string, backend: string): IngressHealthInput {
  return {
    name,
    namespace: "net",
    className: "nginx",
    rules: [
      {
        host: `${name}.example.test`,
        paths: [
          {
            path: "/",
            pathType: "Prefix",
            backendService: backend,
            backendPort: "80",
            resourceBackend: null,
          },
        ],
      },
    ],
    defaultBackend: null,
    loadBalancerIps: [],
    tlsConfigs: [],
  };
}

function autoscaler(
  name: string,
  condition: { type: string; status: string; reason: string }
): AutoscalerInfo {
  return {
    autoscaler: {
      kind: "HorizontalPodAutoscaler",
      name,
      namespace: "shop",
      existence: "present",
      facts: {
        kind: "autoscaler",
        minReplicas: 1,
        maxReplicas: 5,
        currentReplicas: 2,
        desiredReplicas: 0,
        metrics: [],
        conditions: [
          {
            ...condition,
            message: "unable to get metrics for resource cpu",
            lastTransitionTime: "2026-10-05T11:00:00Z",
          },
        ],
        lastScaleTime: null,
      },
    },
    target: {
      kind: "Deployment",
      name,
      namespace: "shop",
      existence: "notChecked",
      facts: null,
    },
  };
}

function claim(
  name: string,
  status: string,
  ageMs: number
): PersistentVolumeClaimInfo {
  return {
    uid: "",
    name,
    namespace: "shop",
    status,
    volume: null,
    capacity: null,
    accessModes: ["ReadWriteOnce"],
    storageClass: null,
    labels: {},
    annotations: {},
    createdAt: new Date(NOW - ageMs).toISOString(),
  };
}

const NONE = { data: { rows: [], unread: [] }, error: null };

/** A cluster that serves no Gateway API: nothing to list, nothing unread. */
function gatewayApi(over: Partial<GatewayApiInputs> = {}): GatewayApiInputs {
  return {
    installed: { data: false, error: null },
    served: new Set(["Gateway", "GatewayClass", "HTTPRoute", "TCPRoute"]),
    routeKinds: ["HTTPRoute", "TCPRoute"],
    topology: { known: true, refused: false, error: null },
    routes: {
      data: { unread: [], refused: [] },
      error: null,
      refused: false,
    },
    backingError: null,
    board: {
      verdictsKnown: true,
      notServing: [],
      unknown: [],
      serving: [],
      mesh: [],
      pulse: [],
    },
    pulse: [],
    ...over,
  };
}

function routeRow(over: Partial<RouteRow> = {}): RouteRow {
  return {
    kind: "HTTPRoute",
    name: "cart-bad",
    namespace: "shop",
    serves: "cart.example.test",
    servesCopy: null,
    more: 0,
    stop: null,
    tail: null,
    stale: null,
    via: "bad-gw",
    viaRef: null,
    viaGhost: null,
    contested: null,
    createdAt: null,
    serving: true,
    servingKnown: true,
    ...over,
  };
}

function attention(inputs: Partial<AttentionInputs> = {}) {
  return attentionOf(
    {
      overview: overview(),
      scope: null,
      services: { answered: [], unread: [] },
      ingresses: NONE,
      ingressHealth: () => {
        throw new Error("no Ingress here");
      },
      autoscalers: NONE,
      claims: NONE,
      gatewayApi: gatewayApi(),
      now: NOW,
      ...inputs,
    },
    t
  );
}

describe("what Needs attention lists beyond pods", () => {
  /**
   * Sam's `net`: `web` selects nothing that is ready, and the panel said
   * nothing broken. Fails if the Services stop being read through
   * `serviceHealthOf`, or a Service with some addresses serving is listed.
   */
  it("lists a Service with nothing serving and leaves one partly serving to its workload", () => {
    const listed = attention({
      services: services(
        [["web", "web-canary"], 0],
        [["api"], 2],
        [["half"], 1, 1],
        [["dns"], 0, 0, "ExternalName"]
      ),
    });

    expect(
      listed.items.map((item) => [item.kind, item.name, item.tone])
    ).toEqual([
      ["Service", "web", "err"],
      ["Service", "web-canary", "err"],
    ]);
    expect(listed.items[0].reason).toBe("no endpoints");
    expect(listed.items[1].namespace).toBe("net");
  });

  /**
   * Sam's `web`: the Service page knows why nothing is published, a
   * `targetPort` no container declares. The row says what the shared
   * reader says, from the stop the compact read carries. Fails if the row
   * composes its own words or drops the stop.
   */
  it("gives a Service the reason its own reader gives, cause included", () => {
    const web: ServiceHealthGroup = {
      names: ["web"],
      type: "ClusterIP",
      selectorless: false,
      targets: [],
      ready: 0,
      draining: 0,
      notReady: 0,
      unrouted: 2,
      stop: {
        reason: "publishesNothing",
        service: {
          kind: "Service",
          name: "web",
          namespace: "net",
          existence: "present",
          facts: null,
        },
        selector: "app=web",
        pods: 2,
        readyPods: 2,
        unnamedPorts: ["web"],
      },
    };
    const listed = attention({
      services: {
        answered: [{ namespace: "net", networks: [], groups: [web] }],
        unread: [],
      },
    });

    const said = serviceHealthWords(serviceHealthOf(web, web, null), t).reason;
    expect(said).toBeTruthy();
    expect(listed.items[0].detail).toEqual({ says: "ours", text: said });
  });

  /**
   * log-demo's two ready pods behind deny-all-ingress: every client gets
   * nothing, and nothing in Needs attention said so. Fails if a shut
   * Service is left out for its whole-looking counts.
   */
  it("lists a Service whose ready pods a policy shuts, with the policy as the reason", () => {
    const shut: ServiceHealthGroup = {
      names: ["log-demo"],
      type: "ClusterIP",
      selectorless: false,
      targets: [],
      ready: 2,
      draining: 0,
      notReady: 0,
      unrouted: 0,
      stop: {
        reason: "policyRefuses",
        service: {
          kind: "Service",
          name: "log-demo",
          namespace: "net",
          existence: "present",
          facts: null,
        },
        policies: ["deny-all-ingress"],
        ports: [8080],
        noRules: true,
        client: null,
      },
    };
    const listed = attention({
      services: {
        answered: [{ namespace: "net", networks: [], groups: [shut] }],
        unread: [],
      },
    });

    expect(listed.items.map((item) => [item.name, item.tone])).toEqual([
      ["log-demo", "err"],
    ]);
    expect(listed.items[0].reason).toBe("shut by NetworkPolicy");
    expect(listed.items[0].detail).toEqual({
      says: "ours",
      text: "NetworkPolicy deny-all-ingress admits no connection to these pods",
    });
  });

  /**
   * Lena's hello-web at zero: Needs attention, the sidebar badge and the
   * status bar each counted its Service as one problem while the Deployment
   * read Idle. Fails if an idle Service, or an Ingress whose only backend is
   * idle, is counted, or if an empty selector stops being one.
   */
  it("counts no problem for a Service, or an Ingress, in front of a workload scaled to zero", () => {
    const at = (name: string) => ({
      kind: "Service",
      name,
      namespace: "net",
      existence: "present" as const,
      facts: null,
    });
    const group = (name: string, stop: ServiceHealthGroup["stop"]) => ({
      names: [name],
      type: "ClusterIP",
      selectorless: false,
      targets: [],
      ready: 0,
      draining: 0,
      notReady: 0,
      unrouted: 0,
      stop,
    });
    const idle = group("hello-web", {
      reason: "scaledToZero",
      service: at("hello-web"),
      selector: "app=hello-web",
      workloads: [{ ...at("hello-web"), kind: "Deployment" }],
    });
    const empty = group("web", {
      reason: "selectsNothing",
      service: at("web"),
      selector: "app=web",
      near: null,
      makersRead: true,
    });
    const healthOf = (row: IngressHealthInput) =>
      ingressHealthOf({
        ingress: row,
        binding: {
          known: true,
          value: {
            requested: "nginx",
            resolved: "nginx",
            controller: null,
            viaDefault: false,
            available: [],
          },
        },
        backing: { known: true, value: new Map([["hello-web", idle]]) },
        certificates: new Map(),
      });
    const listed = attention({
      services: {
        answered: [{ namespace: "net", networks: [], groups: [idle, empty] }],
        unread: [],
      },
      ingresses: {
        data: { rows: [ingress("hello", "hello-web")], unread: [] },
        error: null,
      },
      ingressHealth: healthOf,
    });

    expect(listed.items.map((item) => item.name)).toEqual(["web"]);
    expect(listed.total).toBe(1);
    expect(
      ingressHealthWords(healthOf(ingress("hello", "hello-web")), t)
    ).toMatchObject({ label: "backend idle", role: "neutral" });
  });

  /**
   * Marco's ledger: the status bar, the sidebar badge and Needs attention
   * would count a Service whose workload waits on pods nobody could read,
   * and one whose workload is still starting them, while the Deployment
   * behind each counts as nothing. Fails if either Service, or an Ingress
   * whose only backend is one of them, is counted, or if a Service that is
   * simply down stops being one.
   */
  it("counts no problem for a Service, or an Ingress, whose workloads wait on their pods", () => {
    const group = (
      name: string,
      why: "comingUp" | "podsUnread" | "crashLooping"
    ): ServiceHealthGroup => ({
      names: [name],
      type: "ClusterIP",
      selectorless: false,
      targets: [],
      ready: 0,
      draining: 0,
      notReady: 1,
      unrouted: 0,
      stop: {
        reason: "noneReady",
        service: {
          kind: "Service",
          name,
          namespace: "net",
          existence: "present",
          facts: null,
        },
        selector: `app=${name}`,
        pods: 1,
        why,
        cause: null,
      },
    });
    const groups = [
      group("ledger", "podsUnread"),
      group("big-pull", "comingUp"),
      group("crash", "crashLooping"),
    ];
    const healthOf = (row: IngressHealthInput) =>
      ingressHealthOf({
        ingress: row,
        binding: {
          known: true,
          value: {
            requested: "nginx",
            resolved: "nginx",
            controller: null,
            viaDefault: false,
            available: [],
          },
        },
        backing: {
          known: true,
          value: new Map(groups.map((g) => [g.names[0], g] as const)),
        },
        certificates: new Map(),
      });
    const listed = attention({
      services: {
        answered: [{ namespace: "net", networks: [], groups }],
        unread: [],
      },
      ingresses: {
        data: {
          rows: [ingress("books", "ledger"), ingress("pull", "big-pull")],
          unread: [],
        },
        error: null,
      },
      ingressHealth: healthOf,
    });

    expect(listed.items.map((item) => [item.kind, item.name])).toEqual([
      ["Service", "crash"],
    ]);
    expect(
      ingressHealthWords(healthOf(ingress("books", "ledger")), t)
    ).toMatchObject({ label: "backend not checked", role: "neutral" });
    expect(
      ingressHealthWords(healthOf(ingress("pull", "big-pull")), t)
    ).toMatchObject({ label: "backend coming up", role: "pending" });
  });

  /**
   * Sam's big-pull: its pod pulling an image had no address yet, and Needs
   * attention listed red "no endpoints" over its own "still starting". Fails
   * if a Service with nothing listed whose workload is coming up, or whose
   * pods were not read, is counted, or one behind no workload stops being.
   */
  it("counts no problem for a Service with no address yet whose workload waits on its pods", () => {
    const ref = (name: string) => ({
      kind: "Service",
      name,
      namespace: "shop",
      existence: "present" as const,
      facts: null,
    });
    const nothingYet = (name: string, podsUnread: boolean) => ({
      reason: "publishesNothingYet" as const,
      service: ref(name),
      selector: `app=${name}`,
      podsUnread,
    });
    const empty = (
      name: string,
      stop: ServiceHealthGroup["stop"]
    ): ServiceHealthGroup => ({
      names: [name],
      type: "ClusterIP",
      selectorless: false,
      targets: [],
      ready: 0,
      draining: 0,
      notReady: 0,
      unrouted: 0,
      stop,
    });
    const groups = [
      empty("big-pull", {
        reason: "noneReady",
        service: ref("big-pull"),
        selector: "app=big-pull",
        pods: 1,
        why: "comingUp",
        cause: null,
      }),
      empty("ledger", nothingYet("ledger", true)),
      empty("orphan", nothingYet("orphan", false)),
    ];
    const listed = attention({
      services: {
        answered: [{ namespace: "shop", networks: [], groups }],
        unread: [],
      },
    });
    expect(listed.items.map((item) => [item.name, item.reason])).toEqual([
      ["orphan", "no endpoints"],
    ]);
  });

  /** An Ingress whose class nothing serves, read by the Ingresses list's own reader. */
  it("lists an Ingress no controller serves", () => {
    const backing: NamespaceBacking = new Map([
      ["api", services([["api"], 2]).answered[0].groups[0]],
    ]);
    const listed = attention({
      ingresses: {
        data: { rows: [ingress("storefront", "api")], unread: [] },
        error: null,
      },
      ingressHealth: (row) =>
        ingressHealthOf({
          ingress: row,
          binding: {
            known: true,
            value: {
              requested: "nginx",
              resolved: null,
              controller: null,
              viaDefault: false,
              available: [],
            },
          },
          backing: { known: true, value: backing },
          certificates: new Map(),
        }),
    });

    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      kind: "Ingress",
      name: "storefront",
      tone: "err",
      reason: "no controller",
    });
    expect(listed.complete).toBe(true);
  });

  /**
   * Dana's `cart`: an HPA that cannot read its metrics scales nothing and
   * looks healthy everywhere but its workload's page. Listed by the
   * condition the cluster wrote, opening the workload it scales; one
   * standing by at zero is a setting, not a fault.
   */
  it("lists an autoscaler its own conditions say is not scaling, opening what it scales", () => {
    const listed = attention({
      autoscalers: {
        data: {
          rows: [
            autoscaler("cart", {
              type: "ScalingActive",
              status: "False",
              reason: "FailedGetResourceMetric",
            }),
            autoscaler("idle", {
              type: "ScalingActive",
              status: "False",
              reason: "ScalingDisabled",
            }),
          ],
          unread: [],
        },
        error: null,
      },
    });

    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      kind: "HorizontalPodAutoscaler",
      name: "cart",
      tone: "warn",
      reason: "FailedGetResourceMetric",
      detail: { says: "said", text: "unable to get metrics for resource cpu" },
      opens: { kind: "Deployment", name: "cart", namespace: "shop" },
    });
  });

  /** A claim provisioning for a few seconds is not news; one stuck past the grace is. */
  it("lists a claim Pending past the grace and not one just made", () => {
    const listed = attention({
      claims: {
        data: {
          rows: [
            claim("data-orders-db-0", "Pending", 10 * 60_000),
            claim("fresh", "Pending", 5_000),
            claim("bound", "Bound", 10 * 60_000),
          ],
          unread: [],
        },
        error: null,
      },
    });

    expect(listed.items.map((item) => item.name)).toEqual(["data-orders-db-0"]);
    expect(listed.items[0]).toMatchObject({ tone: "warn", reason: "Pending" });
  });

  /**
   * A claim whose class binds on first consumer is Pending by design, and
   * was listed as a problem. Fails if it is listed, if a claim naming a
   * class that does not exist is not said to, or if unread classes read as
   * either.
   */
  it("passes over a claim that waits for its pod and names a missing class", () => {
    const cls = (name: string, mode: string, isDefault = false) => ({
      name,
      uid: name,
      provisioner: "rancher.io/local-path",
      reclaimPolicy: "Delete",
      volumeBindingMode: mode,
      allowVolumeExpansion: false,
      isDefault,
      parameters: {},
      labels: {},
      annotations: {},
      createdAt: null,
    });
    const rows = [
      { ...claim("waits", "Pending", 10 * 60_000), storageClass: "local-path" },
      { ...claim("orphan", "Pending", 10 * 60_000), storageClass: "fast-ssd" },
    ];
    const claims = { data: { rows, unread: [] }, error: null };
    const read = attention({
      claims,
      classes: [cls("local-path", "WaitForFirstConsumer", true)],
    });
    expect(read.items.map((item) => item.name)).toEqual(["orphan"]);
    expect(read.items[0]).toMatchObject({
      tone: "err",
      detail: {
        says: "ours",
        text: "StorageClass fast-ssd does not exist, so nothing will provision a volume for it",
      },
    });
    const unread = attention({ claims });
    expect(unread.items.map((item) => item.name)).toEqual(["waits", "orphan"]);
    expect(unread.items[0].detail).toMatchObject({
      text: expect.stringContaining("could not be read"),
    });
  });

  /** The worst row leads whichever reader found it, and the backend's cut still counts. */
  it("ranks errors before warnings and counts what the backend cut", () => {
    const warning: ClusterProblem = {
      severity: "warning",
      kind: "Pod",
      name: "flappy",
      namespace: "shop",
      reason: "Restarting",
      detail: null,
      since: "2026-10-05T10:00:00Z",
      restarts: 7,
      foldedPods: null,
      replaced: false,
    };
    const listed = attention({
      overview: overview({ problems: [warning], problemsTruncated: 3 }),
      services: services([["web"], 0]),
    });

    expect(listed.items.map((item) => item.name)).toEqual(["web", "flappy"]);
    expect(listed.total).toBe(5);
    expect(listed.worst).toBe("err");
  });

  /**
   * Live, 25 pods its ReplicaSet had replaced three days earlier sat above the
   * pods crash-looping now, oldest first. Fails if a replaced row ranks above
   * what is down now in its tone, or is worded as a failed Job's runs.
   */
  it("ranks pods already replaced after what is down now, and words them so", () => {
    const row = (
      name: string,
      since: string,
      replaced: boolean
    ): ClusterProblem => ({
      severity: "critical",
      kind: replaced ? "Deployment" : "Pod",
      name,
      namespace: "shop",
      reason: replaced ? "Evicted" : "CrashLoopBackOff",
      detail: null,
      since,
      restarts: null,
      foldedPods: replaced ? 25 : null,
      replaced,
    });
    const listed = attention({
      overview: overview({
        problems: [
          row("recommendations", "2026-10-02T10:00:00Z", true),
          row("checkout-1", "2026-10-05T11:00:00Z", false),
        ],
      }),
    });

    expect(listed.items.map((item) => item.name)).toEqual([
      "checkout-1",
      "recommendations",
    ]);
    expect(foldedWords(listed.items[1], t)).toBe(
      "25 pods already replaced, the newest"
    );
  });

  /**
   * Live, missing-image's Deployment said "2 of 2 pods: image does not exist"
   * and each of its pods said it again on a row of its own, nowhere near it.
   * Fails if a workload's pods leave its row, if the group is not drawn where
   * the first of it ranked, if a pod whose workload has no row is pulled out
   * of rank, or if a pod with a cause of its own is marked as telling the
   * workload's.
   */
  it("draws a workload's pods under its row, marking the ones its row already tells", () => {
    const pulled: PodCause = {
      says: "blocked",
      container: "app",
      reason: "ImagePullBackOff",
      said: null,
      image: "registry.example.test/app:9.9",
      pull: null,
      secrets: [],
    };
    const exits: PodCause = {
      says: "exits",
      container: "app",
      restarts: 4,
      run: null,
      until: null,
    };
    const row = (
      kind: string,
      name: string,
      since: string,
      over: Partial<ClusterProblem> = {}
    ): ClusterProblem => ({
      severity: "critical",
      kind,
      name,
      namespace: "shop",
      reason: kind === "Pod" ? "ImagePullBackOff" : "ProgressDeadlineExceeded",
      detail: null,
      since,
      restarts: null,
      foldedPods: null,
      replaced: false,
      ...over,
    });
    const app = { kind: "Deployment", name: "app" };
    const lines = attentionLines(
      attention({
        overview: overview({
          problems: [
            row("Deployment", "app", "2026-10-05T11:00:00Z", {
              detail: {
                says: "podsCause",
                cause: pulled,
                pods: 1,
                of: 2,
                said: null,
              },
            }),
            row("Pod", "app-1", "2026-10-05T09:00:00Z", {
              workload: app,
              detail: { says: "cause", cause: pulled, by: null },
            }),
            row("Pod", "lonely", "2026-10-05T10:00:00Z", {
              workload: { kind: "Deployment", name: "quiet" },
            }),
            row("Pod", "app-2", "2026-10-05T11:30:00Z", {
              workload: app,
              detail: { says: "cause", cause: exits, by: null },
            }),
          ],
        }),
      }).items
    );

    expect(
      lines.map((line) =>
        line.at === "item"
          ? [
              line.item.name,
              line.under,
              line.under === "workload" && line.sameCause,
            ]
          : line.at
      )
    ).toEqual([
      ["app", null, false],
      ["app-1", "workload", true],
      ["app-2", "workload", false],
      ["lonely", null, false],
    ]);
  });

  /**
   * Marco's ledger: Unavailable by its controller, its pods refused. Fails if
   * the verdict nobody could confirm is counted, ranked or charged to its
   * namespace, or is dropped instead of carried to Not checked.
   */
  it("carries a verdict its pods could not confirm apart from the count", () => {
    const ledger: ClusterProblem = {
      severity: "critical",
      kind: "Deployment",
      name: "ledger",
      namespace: "team-blind",
      reason: "Unavailable",
      detail: null,
      since: "2026-10-05T02:00:00Z",
      restarts: null,
      foldedPods: null,
      replaced: false,
    };
    const listed = attention({
      overview: overview({ unconfirmed: [ledger] }),
    });

    expect(listed.items).toEqual([]);
    expect(listed.total).toBe(0);
    expect(listed.worst).toBeNull();
    expect(listed.byNamespace.get("team-blind") ?? 0).toBe(0);
    expect(listed.unconfirmed).toMatchObject([
      { kind: "Deployment", name: "ledger", reason: "Unavailable" },
    ]);
  });
});

describe("what Needs attention could not look at", () => {
  /**
   * The thesis, for the list: a kind refused or still reading is named, and
   * the answer is not complete. Fails if any of these branches reads as read,
   * which is what puts "nothing needs attention" on a screen that never looked.
   */
  it("names each kind refused, failed or still reading, and is then not complete", () => {
    const listed = attention({
      overview: overview({
        unread: [
          {
            kind: "StatefulSet",
            namespace: "staging",
            code: "PERMISSION_DENIED",
            message: "statefulsets.apps is forbidden",
          },
        ],
      }),
      services: { answered: [], unread: "reading" },
      autoscalers: { data: undefined, error: new Error("connection refused") },
      claims: {
        data: {
          rows: [],
          unread: [
            {
              namespace: "prod",
              code: "PERMISSION_DENIED",
              message: "forbidden",
            },
          ],
        },
        error: null,
      },
    });

    const state = Object.fromEntries(
      listed.checks.map((check) => [check.kind, check.state])
    );
    expect(state).toEqual({
      Pod: "read",
      Deployment: "read",
      StatefulSet: "unread",
      DaemonSet: "read",
      Job: "read",
      Node: "read",
      Service: "reading",
      Ingress: "read",
      HorizontalPodAutoscaler: "unread",
      PersistentVolumeClaim: "unread",
    });
    expect(listed.complete).toBe(false);
    const hpa = listed.checks.find(
      (check) => check.kind === "HorizontalPodAutoscaler"
    );
    expect(hpa?.unread[0].message).toContain("connection refused");
  });

  /** A list not answered yet is still reading, never an empty one. */
  it("reads a list with no answer and no error as still reading", () => {
    const listed = attention({ ingresses: { data: undefined, error: null } });
    expect(listed.checks.find((check) => check.kind === "Ingress")?.state).toBe(
      "reading"
    );
    expect(listed.complete).toBe(false);
  });

  /**
   * A list whose latest look failed is not checked, though the answer before
   * the failure is still held. Fails if the old answer is taken for a
   * current one, which kept a lost cluster's count "all checked".
   */
  it("reads a list whose latest look failed as not checked", () => {
    const listed = attention({
      claims: {
        data: { rows: [], unread: [] },
        error: new Error("connection refused"),
      },
    });
    const claims = listed.checks.find(
      (check) => check.kind === "PersistentVolumeClaim"
    );
    expect(claims?.state).toBe("unread");
    expect(claims?.unread[0].message).toContain("connection refused");
    expect(listed.complete).toBe(false);
  });

  /**
   * Marco, scoped to team-blind alone: an Ingress list the cluster refused in
   * that namespace said "list is forbidden across the cluster". Fails if a
   * whole refusal of a one-namespace read is placed across the cluster, or a
   * cluster-wide read's refusal stops saying so, or a few namespaces are
   * counted where they could be named.
   */
  it("places a whole refusal in the namespaces the list was asked in", () => {
    const refusal = Object.assign(new Error("ingresses is forbidden"), {
      code: "PERMISSION_DENIED",
    });
    const said = (scope: readonly string[] | null) =>
      checkSaid(
        attention({
          scope,
          ingresses: { data: undefined, error: refusal },
        }).checks.find((check) => check.kind === "Ingress")!,
        t
      );
    expect(said(["team-blind"])).toContain("in team-blind");
    expect(said(["team-blind", "team-checkout"])).toContain(
      "in team-blind and team-checkout"
    );
    expect(said(["a", "b", "c", "d"])).toContain("in 4 namespaces");
    expect(said(null)).toContain("across the cluster");
  });

  /**
   * The shell reads these once a minute. An answer older than that is not
   * a reading of now, and the count must not say every kind was checked.
   * Fails if the overdue branch of either the lists or the Services is
   * dropped.
   */
  it("reads an answer older than its rate as still reading", () => {
    const listed = attention({
      autoscalers: { ...NONE, overdue: true },
      services: { answered: [], unread: [], overdue: true },
    });
    const state = Object.fromEntries(
      listed.checks.map((check) => [check.kind, check.state])
    );
    expect(state.HorizontalPodAutoscaler).toBe("reading");
    expect(state.Service).toBe("reading");
    expect(listed.complete).toBe(false);
  });

  /** Every kind read and nothing flagged is the one complete, empty answer. */
  it("is complete only when every kind answered", () => {
    const listed = attention();
    expect(listed.items).toEqual([]);
    expect(listed.complete).toBe(true);
    expect(listed.worst).toBeNull();
  });
});

describe("what Needs attention lists of Gateway API", () => {
  const refused = gatewayApi({
    installed: { data: true, error: null },
    pulse: [
      {
        gateway: "bad-gw",
        namespace: "traefik",
        say: "is not programmed by its controller: ListenersNotValid",
        reason: "ListenersNotValid",
        why: "ListenersNotValid: All Listeners must be valid. Listener odd: PortUnavailable.",
      },
    ],
    board: {
      verdictsKnown: true,
      notServing: [
        routeRow({
          serving: false,
          stop: {
            at: "gateway",
            short: "ListenersNotValid",
            say: "Gateway bad-gw is not programmed",
          },
        }),
      ],
      unknown: [],
      serving: [routeRow({ name: "cart-good" })],
      mesh: [],
      pulse: [],
    },
  });

  /**
   * bad-gw's controller refused it and the rail went red, while the Overview
   * and the status bar said "0 problems in traefik". Fails if a refused
   * Gateway or a route it stops is left out of the count, or counted in a
   * namespace other than its own.
   */
  it("lists a Gateway its controller refused and the route it stops, each in its own namespace", () => {
    const found = attention({ gatewayApi: refused });

    expect(
      found.items.map((item) => [item.kind, item.name, item.reason])
    ).toEqual([
      ["Gateway", "bad-gw", "ListenersNotValid"],
      ["HTTPRoute", "cart-bad", "stops at gateway"],
    ]);
    expect(found.items[0]).toMatchObject({
      tone: "err",
      detail: {
        says: "ours",
        text: expect.stringMatching(/^ListenersNotValid: All Listeners/),
      },
    });
    expect(found.items[1].detail).toEqual({
      says: "ours",
      text: "Gateway bad-gw is not programmed.",
    });
    expect(found.byNamespace.get("traefik")).toBe(1);
    expect(found.byNamespace.get("shop")).toBe(1);
    expect(found.total).toBe(2);
    expect(found.complete).toBe(true);
  });

  /**
   * A token refused the Gateways read "0 problems" over routes nobody could
   * judge. Fails if a Gateway API read that did not answer leaves the count
   * whole, or a verdict still being read is called unread.
   */
  it("calls the count a floor where Gateway API could not be read", () => {
    const check = (input: GatewayApiInputs, kind: string) =>
      attention({ gatewayApi: input }).checks.find((c) => c.kind === kind);
    const installed = { data: true, error: null };

    expect(
      check(
        gatewayApi({
          installed,
          topology: { known: false, refused: true, error: null },
        }),
        "Gateway"
      )
    ).toMatchObject({
      state: "unread",
      unread: [{ namespace: null, code: "PERMISSION_DENIED" }],
    });
    expect(
      check(
        gatewayApi({
          installed,
          routes: {
            data: {
              unread: [],
              refused: [
                {
                  kind: "TCPRoute",
                  code: "PERMISSION_DENIED",
                  message: "tcproutes is forbidden",
                },
              ],
            },
            error: null,
            refused: false,
          },
        }),
        "TCPRoute"
      )
    ).toMatchObject({
      state: "unread",
      unread: [{ message: "tcproutes is forbidden" }],
    });
    const untold = {
      ...refused.board,
      notServing: [],
      unknown: [routeRow({ servingKnown: false })],
    };
    expect(
      check(gatewayApi({ installed, board: untold }), "HTTPRoute")
    ).toMatchObject({ state: "unread", unread: [{ namespace: "shop" }] });
    expect(
      check(
        gatewayApi({ installed, board: { ...untold, verdictsKnown: false } }),
        "HTTPRoute"
      )
    ).toMatchObject({ state: "reading", unread: [] });
    expect(
      attention({
        gatewayApi: gatewayApi({ installed: { data: undefined, error: null } }),
      }).complete
    ).toBe(false);
    expect(
      attention({ gatewayApi: gatewayApi() }).checks.map((c) => c.kind)
    ).not.toContain("Gateway");
  });
});

describe("the word a row's reason is printed in", () => {
  const ru: T = (section, key, values) => translate("ru", section, key, values);

  /**
   * A Stalled Deployment's row read "Stalled" in a Russian panel, and an
   * Unavailable one "Unavailable". Every rollout verdict is the app's and
   * the reader's language; a pod's reason is the kubelet's and is matched
   * against kubectl, so it stays as written.
   */
  it("words a workload's verdict and leaves the cluster's own reasons alone", () => {
    expect(reasonWord({ kind: "Deployment", reason: "Stalled" }, ru)).toBe(
      "Застрял"
    );
    expect(reasonWord({ kind: "DaemonSet", reason: "Degraded" }, ru)).toBe(
      "Деградировал"
    );
    expect(reasonWord({ kind: "Deployment", reason: "Unavailable" }, ru)).toBe(
      "Недоступен"
    );
    expect(
      reasonWord({ kind: "Deployment", reason: "ProgressDeadlineExceeded" }, ru)
    ).toBe("ProgressDeadlineExceeded");
    expect(reasonWord({ kind: "Job", reason: "Retrying" }, ru)).toBe(
      "Повторяет попытку"
    );
    expect(reasonWord({ kind: "Pod", reason: "Degraded" }, ru)).toBe(
      "Degraded"
    );
    expect(reasonWord({ kind: "Pod", reason: "CrashLoopBackOff" }, ru)).toBe(
      "CrashLoopBackOff"
    );
  });

  /**
   * Sam's and Marco's rows said `CrashLoopBackOff` for pods kubectl showed
   * Running, a word the kubelet never wrote for them. Fails if the loop this
   * app reads off a pod's exits is printed in the kubelet's word, or left
   * untranslated.
   */
  it("words a crash loop the app read off the exits as its own", () => {
    expect(reasonWord({ kind: "Pod", reason: "CrashLooping" }, ru)).toBe(
      "В цикле падений"
    );
  });

  /**
   * Sam's Needs attention read "Restarting" in English beside Russian rows:
   * the Overview's word for exits after short runs is the app's, not the
   * kubelet's. Fails if it goes back to the raw code.
   */
  it("words restarts the app read off short runs as its own", () => {
    expect(reasonWord({ kind: "Pod", reason: "Restarting" }, ru)).toBe(
      "Перезапускается"
    );
  });
});
