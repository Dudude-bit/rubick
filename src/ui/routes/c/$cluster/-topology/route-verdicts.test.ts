import { describe, expect, it } from "vite-plus/test";

import type {
  GatewayClassInfo,
  GatewayInfo,
  NodeVerdict,
  RouteInfo,
  TopologyNode,
} from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { routesBoard } from "@/lib/route-rows";
import {
  mapVerdicts,
  verdictSay,
  verdictsUnread,
  withNamedGateways,
} from "./route-verdicts";
import { toneOf } from "./tone";

const t: T = (section, key, values) => translate("en", section, key, values);

const programmed = {
  type: "Programmed",
  status: "True",
  reason: "Programmed",
  message: null,
  lastTransitionTime: null,
};

/** The live check's fixture: a Gateway whose class no controller claimed, its status written by hand. */
const publicGateway: GatewayInfo = {
  uid: "",
  name: "public",
  namespace: "infra",
  apiVersion: "gateway.networking.k8s.io/v1",
  className: "live-check",
  listenerSets: [],
  listenerSetsKnown: true,
  listeners: [
    {
      name: "http",
      port: 80,
      protocol: "HTTP",
      hostname: null,
      tlsMode: null,
      certificateRefs: [],
      allowedNamespaces: "All",
      attachedRoutes: null,
      conditions: [],
      fromListenerSet: null,
    },
  ],
  addresses: ["203.0.113.10"],
  conditions: [programmed],
  generation: 1,
  labels: {},
  annotations: {},
  createdAt: null,
};

const unclaimed: GatewayClassInfo = {
  uid: "",
  name: "live-check",
  controllerName: "example.net/nobody",
  description: null,
  accepted: null,
  conditions: [],
  labels: {},
  annotations: {},
  createdAt: null,
};

const web: RouteInfo = {
  uid: "",
  kind: "HTTPRoute",
  apiVersion: "gateway.networking.k8s.io/v1",
  name: "web",
  namespace: "shop",
  hostnames: ["web.example.com"],
  parentRefs: [
    {
      group: "gateway.networking.k8s.io",
      kind: "Gateway",
      name: "public",
      namespace: "infra",
      sectionName: null,
      port: null,
    },
  ],
  rules: [
    {
      matches: [],
      backendRefs: [
        {
          group: "",
          kind: "Service",
          name: "app",
          namespace: null,
          port: 8080,
          weight: null,
        },
      ],
      hasRedirect: false,
      extensionRefs: [],
    },
  ],
  parents: [
    {
      parent: {
        group: "gateway.networking.k8s.io",
        kind: "Gateway",
        name: "public",
        namespace: "infra",
        sectionName: null,
        port: null,
      },
      controllerName: "example.net/nobody",
      conditions: [{ ...programmed, type: "Accepted", reason: "Accepted" }],
    },
  ],
  generation: 1,
  labels: {},
  annotations: {},
  createdAt: null,
};

const board = (topologyKnown: boolean) =>
  routesBoard(
    [web],
    {
      gateways: topologyKnown ? [publicGateway] : [],
      classes: topologyKnown ? [unclaimed] : [],
      topologyKnown,
      listenerSets: null,
      listenerSetsSaid: null,
      backing: {
        services: [
          {
            name: "app",
            namespace: "shop",
            uid: "uid-app",
            type: "ClusterIP",
            sessionAffinity: "None",
            clusterIp: "10.0.0.1",
            externalName: null,
            externalIps: [],
            loadBalancerIps: [],
            ports: [
              {
                name: null,
                port: 8080,
                targetPort: "8080",
                nodePort: null,
                protocol: "TCP",
              },
            ],
            selector: { app: "app" },
            labels: {},
            annotations: {},
            createdAt: null,
          },
        ],
        published: [],
        backingKnown: true,
        backingError: null,
      },
    },
    t
  );

const node = (
  kind: string,
  namespace: string,
  name: string,
  verdict: NodeVerdict,
  existence: TopologyNode["ref"]["existence"] = "present"
): TopologyNode => ({
  id: `gateway.networking.k8s.io/${kind}/${namespace}/${name}`,
  ref: { kind, name, namespace, existence, facts: null },
  home: namespace,
  verdict,
  app: null,
  pods: null,
  cover: null,
  labels: {},
  annotations: {},
});

const route = node("HTTPRoute", "shop", "web", {
  says: "route",
  stops: [],
  accepted: true,
});
/** The copy a scoped map draws of a Gateway outside its scope. */
const named = node(
  "Gateway",
  "infra",
  "public",
  { says: "exists" },
  "notChecked"
);

const inputs = (verdicts: ReturnType<typeof mapVerdicts>) => ({
  t,
  ingress: () => null,
  stale: new Set<string>(),
  verdicts,
});

describe("a route and a Gateway on the map, as their pages read them", () => {
  /**
   * The Routes page said "Not serving · nothing claims class live-check"
   * while the map drew the route green, and drew the Gateway dashed in a
   * scope on `shop` and green across the cluster. Fails if the map's tone
   * or words for either differ from the page's verdict.
   */
  it("draws a route and its Gateway by the Routes page's verdict, class included", () => {
    const verdicts = mapVerdicts(board(true), [publicGateway], true);
    expect(toneOf(route, inputs(verdicts))).toBe("err");
    expect(verdictSay(verdicts, route)).toBe("nothing claims class live-check");

    const read = withNamedGateways(
      new Map([[named.id, named]]),
      verdicts,
      new WeakMap()
    ).get(named.id)!;
    expect(read.ref.existence).toBe("present");
    expect(toneOf(read, inputs(verdicts))).toBe("err");
    expect(verdictSay(verdicts, read)).toBe("nothing claims class live-check");
  });

  /**
   * A token that cannot list Gateways or classes cluster-wide: the route's
   * own Accepted vouches for nothing past it. Fails if such a route, or the
   * Gateway nobody read, is drawn as anything but not checked.
   */
  it("draws a route whose Gateway could not be read as not checked, never as serving", () => {
    const verdicts = mapVerdicts(board(false), undefined, false);
    expect(toneOf(route, inputs(verdicts))).toBe("unknown");
    const nodes = new Map([[named.id, named]]);
    expect(withNamedGateways(nodes, verdicts, new WeakMap())).toBe(nodes);
    const lone = mapVerdicts(
      {
        verdictsKnown: false,
        notServing: [],
        unknown: [],
        serving: [],
        mesh: [],
        pulse: [],
      },
      undefined,
      false
    );
    expect(toneOf(route, inputs(lone))).toBe("unknown");
  });

  /** A Gateway the cluster-wide list answered without is missing, as the Routes page calls it. */
  /**
   * The map drew routes and Gateways not checked once a list behind their
   * verdicts failed, with nothing above it to say why. Fails if a failed
   * list is not named with the cluster's words, or one read is.
   */
  it("says which list behind the verdicts failed, in the cluster's words", () => {
    expect(verdictsUnread({ gateways: null, classes: null }, t)).toBeNull();
    expect(
      verdictsUnread(
        { gateways: null, classes: new Error("gatewayclasses is forbidden") },
        t
      )
    ).toBe(
      "GatewayClass could not be read, so routes and Gateways are drawn not checked: gatewayclasses is forbidden"
    );
  });

  it("calls a named Gateway the cluster-wide list does not hold missing", () => {
    const verdicts = mapVerdicts(board(true), [], true);
    const read = withNamedGateways(
      new Map([[named.id, named]]),
      verdicts,
      new WeakMap()
    ).get(named.id)!;
    expect(read.ref.existence).toBe("missing");
  });
});
