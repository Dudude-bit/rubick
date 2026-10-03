/**
 * The fact no Ingress page can show: several of them, from several
 * namespaces, on one load balancer.
 *
 * `group.name` concatenates their rules into a single listener ordered by
 * `group.order`, and everything the listener has — certificate, scheme, WAF —
 * is shared. From either Ingress's own page the neighbour does not exist.
 */

import { describe, expect, it } from "vitest";

import type { CustomResourceInfo, IngressInfo } from "@/generated/types";
import {
  albGroups,
  countGroups,
  groupSeverity,
  readParams,
  type GroupSources,
} from "./groups";
import { INGRESS_CLASS_PARAMS_CRD } from "./model";

const ingress = (
  name: string,
  namespace: string,
  annotations: Record<string, string> = {},
  host = `${name}.example.com`
): IngressInfo => ({
  name,
  namespace,
  className: null,
  rules: [
    {
      host,
      paths: [
        {
          path: "/",
          pathType: "Prefix",
          backendService: name,
          backendPort: "80",
          resourceBackend: null,
        },
      ],
    },
  ],
  loadBalancerIps: [],
  tlsHosts: [],
  tlsConfigs: [],
  hasCatchAllTls: false,
  defaultBackend: null,
  labels: {},
  annotations: { "kubernetes.io/ingress.class": "alb", ...annotations },
  createdAt: null,
});

const params = (name: string, spec: unknown): CustomResourceInfo => ({
  name,
  namespace: null,
  uid: name,
  apiVersion: "elbv2.k8s.aws/v1beta1",
  kind: "IngressClassParams",
  spec,
  status: null,
  labels: {},
  annotations: {},
  createdAt: null,
  ownerReferences: [],
  generation: null,
});

const sources = (overrides: Partial<GroupSources> = {}): GroupSources => ({
  ingresses: [],
  params: [],
  classParams: new Map(),
  ownClasses: ["alb"],
  unread: [],
  ...overrides,
});

describe("which Ingresses share a load balancer", () => {
  it("puts an Ingress with no group on its own ALB", () => {
    const groups = albGroups(
      sources({ ingresses: [ingress("shop", "web"), ingress("api", "api")] })
    );
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.name === null)).toBe(true);
  });

  /**
   * The reason this page exists. Nothing on either Ingress says the other one
   * is on the same listener.
   */
  it("merges the annotation's group across namespaces and says so", () => {
    const [group] = albGroups(
      sources({
        ingresses: [
          ingress("shop", "web", {
            "alb.ingress.kubernetes.io/group.name": "public",
          }),
          ingress("api", "backend", {
            "alb.ingress.kubernetes.io/group.name": "public",
          }),
        ],
      })
    );

    expect(group.name).toBe("public");
    expect(group.members).toHaveLength(2);
    expect(group.findings).toContainEqual(
      expect.objectContaining({
        kind: "shared",
        namespaces: ["backend", "web"],
      })
    );
  });

  /** A group may also come from the class, which nothing in the app resolved. */
  it("takes the group from the IngressClassParams behind the class", () => {
    const [group] = albGroups(
      sources({
        ingresses: [ingress("shop", "web"), ingress("api", "web")],
        params: [params("shared-alb", { group: { name: "from-class" } })],
        classParams: new Map([["alb", "shared-alb"]]),
      })
    );

    expect(group.name).toBe("from-class");
    expect(group.params?.name).toBe("shared-alb");
  });

  /** A per-Ingress group is an opt-in and outranks whatever the class said. */
  it("lets the annotation override the class's group", () => {
    const groups = albGroups(
      sources({
        ingresses: [
          ingress("shop", "web", {
            "alb.ingress.kubernetes.io/group.name": "own",
          }),
        ],
        params: [params("shared-alb", { group: { name: "from-class" } })],
        classParams: new Map([["alb", "shared-alb"]]),
      })
    );
    expect(groups[0].name).toBe("own");
  });

  /** Two rules of equal order, and nothing states which one wins. */
  it("names an order two members both claim", () => {
    const [group] = albGroups(
      sources({
        ingresses: [
          ingress("shop", "web", {
            "alb.ingress.kubernetes.io/group.name": "public",
            "alb.ingress.kubernetes.io/group.order": "10",
          }),
          ingress("api", "backend", {
            "alb.ingress.kubernetes.io/group.name": "public",
            "alb.ingress.kubernetes.io/group.order": "10",
          }),
        ],
      })
    );

    expect(group.findings).toContainEqual(
      expect.objectContaining({ kind: "order-clash", order: 10 })
    );
  });

  /** A load balancer has one scheme; two members asking for two is a loss. */
  it("names members that disagree about the scheme", () => {
    const [group] = albGroups(
      sources({
        ingresses: [
          ingress("shop", "web", {
            "alb.ingress.kubernetes.io/group.name": "public",
            "alb.ingress.kubernetes.io/scheme": "internet-facing",
          }),
          ingress("api", "backend", {
            "alb.ingress.kubernetes.io/group.name": "public",
            "alb.ingress.kubernetes.io/scheme": "internal",
          }),
        ],
      })
    );

    expect(group.findings).toContainEqual(
      expect.objectContaining({ kind: "disagree", field: "scheme" })
    );
  });

  /**
   * With `ingressclassparams` refused every class naming one got a red "names
   * something absent", right under the page's own note that the kind could
   * not be listed.
   */
  it("does not call a class's parameters missing when they went unread", () => {
    const grouped = {
      ingresses: [
        ingress("shop", "web", {
          "alb.ingress.kubernetes.io/group.name": "public",
        }),
      ],
      classParams: new Map([["alb", "shared-alb"]]),
    };
    const noParams = (unread: GroupSources["unread"]) =>
      albGroups(sources({ ...grouped, unread }))[0].findings.some(
        (finding) => finding.kind === "no-params"
      );

    expect(noParams([{ crd: INGRESS_CLASS_PARAMS_CRD }])).toBe(false);
    expect(noParams([])).toBe(true);
  });

  /**
   * Nor green instead of red: a group whose class names parameters nobody
   * read is not known to be serving.
   */
  it("reads a group behind unread parameters as unknown", () => {
    const [group] = albGroups(
      sources({
        ingresses: [
          ingress("shop", "web", {
            "alb.ingress.kubernetes.io/group.name": "public",
          }),
        ],
        classParams: new Map([["alb", "shared-alb"]]),
        unread: [{ crd: INGRESS_CLASS_PARAMS_CRD }],
      })
    );

    expect(group.paramsKnown).toBe(false);
    expect(groupSeverity(group)).toBe("unknown");
  });

  /**
   * The parameters may name a group, so an Ingress with none of its own is
   * not known to own its ALB — and the sidebar's count of load balancers
   * said three for what the class may well have merged into one.
   */
  it("cannot count load balancers whose membership went unread", () => {
    const unread = sources({
      ingresses: [ingress("shop", "web"), ingress("api", "web")],
      classParams: new Map([["alb", "shared-alb"]]),
      unread: [{ crd: INGRESS_CLASS_PARAMS_CRD }],
    });

    expect(countGroups(unread)).toBeNull();
    expect(countGroups({ ...unread, unread: [] })).toBe(2);
  });

  /**
   * Missing parameters belong to the groups whose class names them. They
   * were copied onto every named group, and never onto an Ingress on its
   * own ALB, which is the one they break.
   */
  it("puts missing parameters on the group whose class names them", () => {
    const groups = albGroups(
      sources({
        ingresses: [
          ingress("shop", "web"),
          ingress("api", "api", {
            "kubernetes.io/ingress.class": "alb-internal",
            "alb.ingress.kubernetes.io/group.name": "internal",
          }),
        ],
        params: [params("internal-alb", {})],
        classParams: new Map([
          ["alb", "absent-alb"],
          ["alb-internal", "internal-alb"],
        ]),
        ownClasses: ["alb", "alb-internal"],
      })
    );
    const noParams = (name: string | null) =>
      groups
        .find((group) => group.name === name)
        ?.findings.filter((finding) => finding.kind === "no-params");

    expect(noParams(null)).toEqual([
      expect.objectContaining({ className: "alb", named: "absent-alb" }),
    ]);
    expect(noParams("internal")).toEqual([]);
  });

  /** Somebody else's Ingress is not this controller's to draw. */
  it("ignores an Ingress of another class", () => {
    expect(
      albGroups(
        sources({
          ingresses: [
            ingress("shop", "web", { "kubernetes.io/ingress.class": "nginx" }),
          ],
        })
      )
    ).toEqual([]);
  });
});

describe("what the class configured", () => {
  it("reads the fields nothing in the app resolved before", () => {
    const read = readParams(
      params("shared-alb", {
        group: { name: "public" },
        scheme: "internet-facing",
        ipAddressType: "dualstack",
        certificateArn: "arn:aws:acm:eu-west-1:1:certificate/abcd",
        sslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06",
        wafv2AclArn: "arn:aws:wafv2:eu-west-1:1:regional/webacl/edge/xyz",
        inboundCIDRs: ["10.0.0.0/8"],
        subnets: ["subnet-a", "subnet-b"],
      })
    );

    expect(read).toMatchObject({
      group: "public",
      scheme: "internet-facing",
      ipAddressType: "dualstack",
      sslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06",
      inboundCidrs: ["10.0.0.0/8"],
      subnets: ["subnet-a", "subnet-b"],
    });
    expect(read.wafAcl).toContain("webacl");
  });
});
