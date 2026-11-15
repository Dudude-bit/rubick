import { describe, expect, it } from "vite-plus/test";

import type {
  GatewayInfo,
  NodeVerdict,
  ObjectRef,
  ResourceConnections,
  Rollout,
  ServicePublished,
  TopologyNode,
} from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { IngressHealth } from "@/lib/ingress-health";
import { ingressHealthWords } from "@/lib/ingress-health";
import { programmedWord } from "@/lib/route-trace";
import {
  healthFromConnections,
  serviceHealthWords,
} from "@/lib/service-health";
import { statusRole } from "@/lib/status-role";
import { rolloutBadge } from "../-object/rollout-badge";
import {
  ROLE_TONE,
  serviceHealthOfNode,
  toneOf,
  type ToneInputs,
} from "./tone";

const t: T = (section, key, values) => translate("en", section, key, values);
const inputs: ToneInputs = { t, ingress: () => null, stale: new Set() };

const ref = (
  kind: string,
  existence: ObjectRef["existence"] = "present"
): ObjectRef => ({
  kind,
  name: "web",
  namespace: "shop",
  existence,
  facts: null,
});

const node = (object: ObjectRef, verdict: NodeVerdict): TopologyNode => ({
  id: `/${object.kind}/shop/web`,
  ref: object,
  home: "shop",
  verdict,
  app: null,
  pods: null,
  cover: null,
  labels: {},
  annotations: {},
});

const ROLLOUTS: Rollout[] = [
  { state: "ready" },
  { state: "idle" },
  { state: "paused" },
  { state: "stalled", message: null, serving: 1 },
  {
    state: "unavailable",
    reason: null,
    message: null,
    available: 0,
    desired: 2,
  },
  { state: "unobserved", available: 1, desired: 2 },
  { state: "rollingOut", updated: 1, desired: 2 },
  { state: "comingUp", available: 1, desired: 2 },
  { state: "scalingDown", current: 3, desired: 2 },
  { state: "short", available: 1, desired: 2 },
];

describe("a map node's colour", () => {
  /**
   * "Pods with no owner" was ringed not checked on a cluster whose pods were
   * read. Fails if their node stops taking the colour the Pods list gives
   * their statuses, or a running pod that is not ready reads green.
   */
  it("colours pods with no owner by their statuses, and a running pod not ready as a warning", () => {
    const ownerless = (
      statuses: { status: string; total: number; ready: number }[]
    ) => toneOf(node(ref("Pod"), { says: "ownerless", statuses }), inputs);
    expect(ownerless([{ status: "Running", total: 2, ready: 2 }])).toBe("ok");
    expect(ownerless([{ status: "Running", total: 2, ready: 1 }])).toBe("warn");
    expect(
      ownerless([
        { status: "CrashLoopBackOff", total: 1, ready: 0 },
        { status: "Running", total: 1, ready: 1 },
      ])
    ).toBe(ROLE_TONE[statusRole("CrashLoopBackOff")]);
  });

  /** The workload's badge on its list, its page and its peek is `rolloutBadge`; a map that coloured the same verdict otherwise would disagree with all three. */
  it("is a workload's own badge for every verdict its page can give", () => {
    for (const rollout of ROLLOUTS)
      expect(
        toneOf(node(ref("Deployment"), { says: "rollout", rollout }), inputs),
        rollout.state
      ).toBe(ROLE_TONE[rolloutBadge(rollout, t).role]);
  });

  /** A verdict its pods were not read to confirm is neither healthy nor failing: the page greys it, and the map rings it. */
  it("rings a workload whose pods were not read, whatever its controller says", () => {
    const rollout: Rollout = {
      state: "podsUnread",
      controller: { state: "ready" },
    };
    expect(
      toneOf(node(ref("Deployment"), { says: "rollout", rollout }), inputs)
    ).toBe("unknown");
  });

  /** The Service's page reads its health from its neighbourhood's published endpoints; the map is handed the same entry and must come to the same verdict. */
  it("is a Service's page verdict from the same published endpoints", () => {
    const service: ObjectRef = {
      ...ref("Service"),
      facts: {
        kind: "service",
        type: "ClusterIP",
        clusterIp: "10.0.0.1",
        externalName: null,
        selector: "app=web",
        ports: [],
      },
    };
    for (const [ready, notReady] of [
      [2, 0],
      [1, 1],
      [0, 2],
    ]) {
      const published: ServicePublished = {
        service,
        source: "slices",
        slices: 1,
        ready,
        draining: 0,
        notReady,
        unrouted: 0,
        unroutedReady: 0,
        ports: [],
        endpoints: [],
        whole: true,
        unpublished: [],
        stop: null,
      };
      const page: ResourceConnections = {
        subject: service,
        edges: [],
        stops: [],
        published: [published],
        notLookedAt: [],
      };
      const verdict: NodeVerdict = { says: "service", published, unread: null };
      const drawn = node(service, verdict);
      expect(
        serviceHealthOfNode(
          drawn,
          verdict as Extract<NodeVerdict, { says: "service" }>
        )
      ).toEqual(healthFromConnections(page, null));
      expect(toneOf(drawn, inputs)).toBe(
        ROLE_TONE[serviceHealthWords(healthFromConnections(page, null), t).role]
      );
    }
  });

  /** A Service none of whose endpoints were read is unknown on its page; green or red here would be a guess. */
  it("rings a Service nothing it publishes was read of", () => {
    const service: ObjectRef = {
      ...ref("Service"),
      facts: {
        kind: "service",
        type: "ClusterIP",
        clusterIp: null,
        externalName: null,
        selector: "app=web",
        ports: [],
      },
    };
    expect(
      toneOf(
        node(service, {
          says: "service",
          published: null,
          unread: "endpointslices is forbidden",
        }),
        inputs
      )
    ).toBe("unknown");
  });

  /** The Gateway list, page and peek word "programmed" by `programmedWord`. */
  it("is a Gateway's programmed word", () => {
    const gateway = (status: string | null): GatewayInfo =>
      ({
        name: "public",
        namespace: "shop",
        conditions: status
          ? [{ type: "Programmed", status, reason: null, message: null }]
          : [],
        listeners: [],
        listenerSets: [],
        listenerSetsKnown: true,
      }) as unknown as GatewayInfo;
    for (const status of ["True", "False", "Unknown", null]) {
      const row = gateway(status);
      expect(
        toneOf(node(ref("Gateway"), { says: "gateway", row }), inputs),
        String(status)
      ).toBe(ROLE_TONE[programmedWord(row, t).role]);
    }
  });

  /** A claim's list badge colours its phase by `statusRole`. */
  it("is a claim's phase as its list colours it", () => {
    for (const phase of ["Bound", "Pending", "Lost"])
      expect(
        toneOf(
          node(ref("PersistentVolumeClaim"), { says: "claim", phase }),
          inputs
        )
      ).toBe(ROLE_TONE[statusRole(phase)]);
  });

  /** An Ingress is coloured by the Ingresses list's own hook; until it answers, nothing is claimed. */
  it("is an Ingress's verdict from the list's hook, and unknown until it has one", () => {
    const row = { name: "web", namespace: "shop" } as never;
    expect(toneOf(node(ref("Ingress"), { says: "ingress", row }), inputs)).toBe(
      "unknown"
    );
    const health: IngressHealth = {
      problems: [{ kind: "backendMissing", service: "web" }],
    } as unknown as IngressHealth;
    expect(
      toneOf(node(ref("Ingress"), { says: "ingress", row }), {
        ...inputs,
        ingress: () => health,
      })
    ).toBe(ROLE_TONE[ingressHealthWords(health, t).role]);
  });

  /** What nobody read earns no colour, whatever its verdict says, and a kind whose read broke is not drawn as current. */
  it("rings what was not checked and what a broken read last saw", () => {
    const ready: NodeVerdict = { says: "rollout", rollout: { state: "ready" } };
    expect(toneOf(node(ref("Deployment", "notChecked"), ready), inputs)).toBe(
      "unknown"
    );
    expect(
      toneOf(node(ref("Deployment"), ready), {
        ...inputs,
        stale: new Set(["Deployment"]),
      })
    ).toBe("unknown");
    expect(
      toneOf(node(ref("Secret", "missing"), { says: "exists" }), inputs)
    ).toBe("err");
    expect(toneOf(node(ref("Deployment"), ready), inputs)).toBe("ok");
  });
});
