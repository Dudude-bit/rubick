import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/** Every command a source asked, by name. */
const asked = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/commands", () => ({
  commands: new Proxy(
    {},
    {
      get: (_, name) => async () => {
        asked.push(String(name));
        return {};
      },
    }
  ),
}));

import { queryKeys } from "@/lib/query-keys";
import { RESOURCE_REGISTRY } from "@/lib/resource-registry";
import { flatten, peekQueryKey, resolveSource } from "./peek-sources";

/** What the peek asks for an object, and where it keeps the answer. */
async function peekOf(target: {
  kind: string;
  name: string;
  namespace?: string | null;
  crd?: string;
}) {
  asked.length = 0;
  await resolveSource(target).fetch(target.name, target.namespace ?? null);
  return { asked: [...asked], key: peekQueryKey(target) };
}

/**
 * The getter each detail page hands `useResourceDetail`, read from the pages
 * rather than restated, so a page that changes what it asks shows up here.
 */
function detailGetters(): Array<[string, string, string | null]> {
  const dir = join("src", "pages");
  return readdirSync(dir)
    .filter((file) => file.endsWith("Detail.tsx"))
    .flatMap((file) => {
      const found = readFileSync(join(dir, file), "utf8").match(
        /resourceKind:\s*ResourceType\.(\w+),(\s*isClusterScoped:\s*true,)?\s*fetchResource:[\s\S]*?commands\.(\w+)\(/
      );
      if (!found) return [];
      const [, kind, clusterScoped, getter] = found;
      return [[kind, getter, clusterScoped ? null : "ns"]] as Array<
        [string, string, string | null]
      >;
    });
}

/**
 * The peek's Overview is the detail page's own cache entry, so the two must
 * ask the same `get_*`: two commands under one key hand one screen the
 * other's shape. A kind the peek reads as a bare manifest keeps its own
 * entry for the same reason.
 */
describe("the peek's Overview against the detail pages", () => {
  const getters = detailGetters();

  /** Would pass over an empty scan, which is what a broken pattern gives. */
  it("finds the detail pages it compares against", () => {
    expect(getters.length).toBeGreaterThanOrEqual(20);
  });

  it.each(getters)(
    "shares the %s page's entry only when it asks what the page asks",
    async (kind, getter, namespace) => {
      const peek = await peekOf({ kind, name: "x", namespace });
      expect([getter, "getManifest"]).toContain(peek.asked[0]);
      const shared =
        JSON.stringify(peek.key) ===
        JSON.stringify(queryKeys.detail(kind, namespace, "x"));
      expect(shared).toBe(peek.asked[0] === getter);
    }
  );

  it("reads a route where the route's page does", async () => {
    const page = readFileSync(
      join("src", "pages", "GatewayRouteDetail.tsx"),
      "utf8"
    );
    expect(page).toMatch(/fetchResource:[^\n]*commands\.getGatewayRoute\(/);
    const peek = await peekOf({
      kind: "HTTPRoute",
      name: "x",
      namespace: "ns",
    });
    expect(peek.asked).toEqual(["getGatewayRoute"]);
    expect(peek.key).toEqual(queryKeys.detail("HTTPRoute", "ns", "x"));
  });

  /**
   * The badge read any True as accepted, so a route one controller was
   * still deciding about said Accepted here and "unknown" on the Gateway
   * page. It reads the one rule `route-verdict.ts` keeps now, and a verdict
   * nobody has given is said as such: `undefined` erased the badge, which
   * is the peek going quiet where the Gateway page speaks.
   */
  it("does not badge a route accepted while one controller is still deciding", () => {
    const verdict = (status: string, reason: string) => ({
      parent: {
        group: "gateway.networking.k8s.io",
        kind: "Gateway",
        name: "edge",
        namespace: null,
        sectionName: null,
        port: null,
      },
      controllerName: `${reason}.example.net/gw`,
      conditions: [
        {
          type: "Accepted",
          status,
          reason,
          message: null,
          lastTransitionTime: null,
        },
      ],
    });
    const route = (parents: ReturnType<typeof verdict>[]) => ({
      kind: "HTTPRoute",
      apiVersion: "gateway.networking.k8s.io/v1",
      name: "x",
      namespace: "ns",
      hostnames: [],
      parentRefs: [],
      rules: [],
      parents,
      generation: 1,
      labels: {},
      annotations: {},
      createdAt: null,
    });
    const target = { kind: "HTTPRoute", name: "x", namespace: "ns" };
    const badge = (parents: ReturnType<typeof verdict>[]) =>
      resolveSource(target).summarise(
        route(parents),
        target,
        ((_section: string, key: string) => key) as never
      ).status;

    expect(badge([verdict("True", "Accepted")])).toBe("Accepted");
    expect(
      badge([verdict("True", "Accepted"), verdict("Unknown", "Pending")])
    ).toBe("Unknown");
    expect(
      badge([verdict("True", "Accepted"), verdict("False", "Refused")])
    ).toBe("Refused");
    expect(badge([])).toBeNull();
    expect(
      badge([{ ...verdict("True", "Accepted"), conditions: [] }])
    ).toBeNull();
  });

  const gateway = (
    conditions: object[],
    listenerConditions: object[] = []
  ) => ({
    name: "edge",
    namespace: "ns",
    apiVersion: "gateway.networking.k8s.io/v1",
    className: "envoy",
    listenerSets: [],
    listenerSetsKnown: true,
    listeners: [
      {
        name: "https",
        port: 443,
        protocol: "HTTPS",
        hostname: null,
        attachedRoutes: 1,
        conditions: listenerConditions,
        certificateRefs: [],
        fromListenerSet: null,
      },
    ],
    addresses: [],
    conditions,
    generation: 1,
    labels: {},
    annotations: {},
    createdAt: null,
  });
  const gatewayPeek = (subject: ReturnType<typeof gateway>) => {
    const target = { kind: "Gateway", name: "edge", namespace: "ns" };
    return resolveSource(target).summarise(
      subject,
      target,
      ((_section: string, key: string) => key) as never
    );
  };
  const said = (type: string, status: string, reason: string) => ({
    type,
    status,
    reason,
    message: null,
    lastTransitionTime: null,
  });

  /** A Gateway no controller has written Programmed on had no badge at all. */
  it("says a Gateway nobody has programmed has reported nothing", () => {
    expect(gatewayPeek(gateway([])).status).toBeNull();
    expect(
      gatewayPeek(gateway([said("Programmed", "True", "Programmed")])).status
    ).toBe("Programmed");
  });

  /**
   * `Conflicted=False` is the healthy answer, and the listener row took any
   * False for broken: an Istio listener read red with "— NoConflicts".
   */
  it("reads a listener's conditions by their own polarity", () => {
    const listenerTone = (conditions: object[]) =>
      gatewayPeek(gateway([], conditions)).groups[1].items[0].tone;

    expect(
      listenerTone([
        said("Accepted", "True", "Accepted"),
        said("Conflicted", "False", "NoConflicts"),
        said("OverlappingTLSConfig", "False", "NoOverlap"),
      ])
    ).toBeUndefined();
    expect(listenerTone([said("Conflicted", "True", "HostnameConflict")])).toBe(
      "err"
    );
    expect(
      listenerTone([said("ResolvedRefs", "False", "InvalidCertificateRef")])
    ).toBe("err");
  });

  it("reads a CRD where the CRD page does", async () => {
    const peek = await peekOf({
      kind: "CustomResourceDefinition",
      name: "applications.argoproj.io",
    });
    expect(peek.asked).toEqual(["getCrd"]);
    expect(peek.key).toEqual(queryKeys.crd("applications.argoproj.io"));
  });

  it("reads a custom resource where its page does", async () => {
    const peek = await peekOf({
      kind: "Application",
      name: "shop",
      namespace: "argocd",
      crd: "applications.argoproj.io",
    });
    expect(peek.asked).toEqual(["getCustomResource"]);
    expect(peek.key).toEqual(
      queryKeys.customResource("applications.argoproj.io", "argocd", "shop")
    );
  });
});
import { CLUSTER_SOURCES } from "./peek-sources-cluster";
import { GATEWAY_SOURCES } from "./peek-sources-gateway";
import { NETWORK_SOURCES } from "./peek-sources-network";
import { CONFIG_STORAGE_SOURCES } from "./peek-sources-storage";
import { WORKLOAD_SOURCES } from "./peek-sources-workloads";

describe("what a peek shows of a spec it has no schema for", () => {
  /**
   * The reported case: an IngressRoute's whole point — the match rule, the
   * service, the priority — sits inside `spec.routes`, and the peek printed
   * `routes: 1 entries` and nothing else. An array of objects is descended
   * with indexed paths, not counted.
   */
  it("descends into an array of objects instead of counting it", () => {
    const rows = flatten(
      {
        entryPoints: ["web", "websecure"],
        routes: [
          {
            match: "Host(`api.example.com`)",
            priority: 10,
            services: [{ name: "api", port: 8080 }],
          },
        ],
      },
      12
    );

    expect(rows).toContainEqual({
      label: "routes.0.match",
      value: "Host(`api.example.com`)",
      mono: true,
    });
    expect(rows).toContainEqual({
      label: "routes.0.priority",
      value: "10",
      mono: true,
    });
    expect(rows).toContainEqual({
      label: "routes.0.services.0.name",
      value: "api",
      mono: true,
    });
  });

  /** A scalar list stays one row — `web · websecure` reads, ten rows do not. */
  it("keeps a scalar array joined on one row", () => {
    const rows = flatten({ entryPoints: ["web", "websecure"] }, 12);
    expect(rows).toEqual([
      { label: "entryPoints", value: "web · websecure", mono: true },
    ]);
  });

  /** The cap still holds however deep the spec goes. */
  it("stops at the row limit", () => {
    const rows = flatten(
      { routes: Array.from({ length: 40 }, () => ({ match: "x" })) },
      12
    );
    expect(rows).toHaveLength(12);
  });

  /**
   * A conditions array is the one shape the whole API machinery shares, so
   * it is read as conditions: one row per verdict, coloured with the same
   * polarity every condition row in the app uses — not six grey fragments
   * per entry.
   */
  it("reads a conditions array as verdicts, one toned row each", () => {
    const rows = flatten(
      {
        conditions: [
          {
            type: "Accepted",
            status: "True",
            reason: "Accepted",
            message: "",
            lastTransitionTime: "2026-08-19T20:00:00Z",
          },
          {
            type: "Programmed",
            status: "False",
            reason: "Invalid",
            message: "listener not found",
          },
        ],
      },
      12
    );

    expect(rows).toContainEqual({
      label: "conditions.Accepted",
      value: "True",
      mono: true,
      tone: "ok",
    });
    expect(rows).toContainEqual({
      label: "conditions.Programmed",
      value: "False — Invalid: listener not found",
      mono: true,
      tone: "err",
    });
  });

  /** Negative-polarity conditions keep their meaning: pressure off is green. */
  it("does not paint a healthy negative condition red", () => {
    const rows = flatten(
      { conditions: [{ type: "MemoryPressure", status: "False" }] },
      12
    );
    expect(rows).toContainEqual({
      label: "conditions.MemoryPressure",
      value: "False",
      mono: true,
      tone: "ok",
    });
  });

  /** An array under the name that is not condition-shaped stays generic. */
  it("leaves a non-condition 'conditions' array to the generic walk", () => {
    const rows = flatten({ conditions: [{ match: "x" }] }, 12);
    expect(rows).toContainEqual({
      label: "conditions.0.match",
      value: "x",
      mono: true,
    });
  });
});

describe("the families the peek's sources are spread from", () => {
  const kinds = [
    CLUSTER_SOURCES,
    GATEWAY_SOURCES,
    NETWORK_SOURCES,
    CONFIG_STORAGE_SOURCES,
    WORKLOAD_SOURCES,
  ].flatMap((family) => Object.keys(family));

  /**
   * One object literal refused a kind written twice; five spread into one
   * do not, and the family spread last would silently replace the other's
   * reading of that kind.
   */
  it("claims each kind in only one family", () => {
    expect(kinds.filter((kind, at) => kinds.indexOf(kind) !== at)).toEqual([]);
  });

  /**
   * A kind no family claims is not an error: `resolveSource` hands it to the
   * manifest walk, and the peek draws a dotted-path dump where it drew the
   * kind. Checking only that the families were not empty let one go.
   */
  it("reads every registered kind itself, except the ones read as a manifest", () => {
    const readAsManifest = [
      "Event",
      "HorizontalPodAutoscaler",
      "PodDisruptionBudget",
      "ReplicaSet",
    ];
    const registered: string[] = RESOURCE_REGISTRY.map(
      (definition) => definition.kind
    );

    expect(registered.filter((kind) => !kinds.includes(kind)).sort()).toEqual(
      readAsManifest
    );
    expect(kinds.filter((kind) => !registered.includes(kind))).toEqual([]);
  });
});
