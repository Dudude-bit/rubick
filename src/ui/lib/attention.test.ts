import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type {
  AutoscalerInfo,
  ClusterOverview,
  ClusterProblem,
  IngressHealthInput,
  PersistentVolumeClaimInfo,
  ServiceHealthGroup,
} from "@/generated/types";
import { attentionOf, type AttentionInputs } from "./attention";
import { ingressHealthOf, type NamespaceBacking } from "./ingress-health";

const t: T = (section, key, values) => translate("en", section, key, values);

const NOW = Date.parse("2026-10-05T12:00:00Z");

function overview(over: Partial<ClusterOverview> = {}): ClusterOverview {
  return {
    problems: [],
    problemsTruncated: 0,
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
    name,
    namespace: "shop",
    status,
    volume: null,
    capacity: null,
    accessModes: ["ReadWriteOnce"],
    storageClass: "",
    labels: {},
    annotations: {},
    createdAt: new Date(NOW - ageMs).toISOString(),
  };
}

const NONE = { data: { rows: [], unread: [] }, error: null };

function attention(inputs: Partial<AttentionInputs> = {}) {
  return attentionOf(
    {
      overview: overview(),
      services: { answered: [], unread: [] },
      ingresses: NONE,
      ingressHealth: () => {
        throw new Error("no Ingress here");
      },
      autoscalers: NONE,
      claims: NONE,
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
    expect(listed.items[0].reason).toBe("No endpoints");
    expect(listed.items[1].namespace).toBe("net");
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
      tone: "err",
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
    };
    const listed = attention({
      overview: overview({ problems: [warning], problemsTruncated: 3 }),
      services: services([["web"], 0]),
    });

    expect(listed.items.map((item) => item.name)).toEqual(["web", "flappy"]);
    expect(listed.total).toBe(5);
    expect(listed.worst).toBe("err");
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
