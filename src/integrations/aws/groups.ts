/**
 * Which Ingresses share one ALB, which is the fact this controller has that
 * nothing else in Kubernetes does.
 *
 * An `Ingress` normally owns its load balancer. The AWS Load Balancer
 * Controller breaks that: `alb.ingress.kubernetes.io/group.name`, or a
 * `group.name` on the `IngressClassParams` behind its class, **merges
 * Ingresses from different namespaces onto a single ALB**. Their rules are
 * concatenated and ordered by `group.order`, so one team's Ingress can shadow
 * another team's paths, and the two objects share a certificate, a scheme, a
 * WAF and a subnet set that only one of them declared.
 *
 * None of that is visible from an Ingress — its own page shows its own rules
 * and its own annotations, and the neighbour it shares a listener with is in
 * another namespace. So this file joins them, and the page draws the group
 * rather than the object.
 *
 * The second join is `IngressClass.spec.parameters` → `IngressClassParams`,
 * which is where the scheme, the certificate, the WAF ACL and the subnets of
 * every ALB in the cluster live; `IngressClassBinding` carries only a name, a
 * controller and a default flag.
 */

import type { CustomResourceInfo, IngressInfo } from "@/generated/types";
import { getValueByPath } from "../kit";
import { INGRESS_CLASS_PARAMS_CRD } from "./model";

const PREFIX = "alb.ingress.kubernetes.io/";
export const GROUP_NAME_ANNOTATION = `${PREFIX}group.name`;
export const GROUP_ORDER_ANNOTATION = `${PREFIX}group.order`;
export const CERTIFICATE_ARN_ANNOTATION = `${PREFIX}certificate-arn`;
export const SCHEME_ANNOTATION = `${PREFIX}scheme`;
const INGRESS_CLASS_ANNOTATION = "kubernetes.io/ingress.class";

/** The class names this controller answers to. */
const ALB_CLASSES = new Set(["alb"]);

/** Which class an Ingress asks for, annotation first as the controller reads it. */
export function classOf(ingress: IngressInfo): string | null {
  return ingress.annotations[INGRESS_CLASS_ANNOTATION] ?? ingress.className;
}

export function claimed(
  ingresses: IngressInfo[],
  /** Classes whose controller is this one, beyond the built-in `alb` name. */
  ownClasses: string[]
): IngressInfo[] {
  const mine = new Set([...ALB_CLASSES, ...ownClasses]);
  return ingresses.filter((ingress) => {
    const asked = classOf(ingress);
    return asked !== null && mine.has(asked);
  });
}

/** What an `IngressClassParams` sets, read once for every surface. */
export interface Params {
  name: string;
  group: string | null;
  scheme: string | null;
  ipAddressType: string | null;
  certificateArn: string | null;
  sslPolicy: string | null;
  wafAcl: string | null;
  inboundCidrs: string[];
  subnets: string[];
  loadBalancerName: string | null;
}

const text = (resource: CustomResourceInfo, path: string): string | null => {
  const value = getValueByPath(resource, path);
  return typeof value === "string" && value !== "" ? value : null;
};

const strings = (resource: CustomResourceInfo, path: string): string[] => {
  const value = getValueByPath(resource, path);
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
};

export function readParams(params: CustomResourceInfo): Params {
  return {
    name: params.name,
    group: text(params, "spec.group.name"),
    scheme: text(params, "spec.scheme"),
    ipAddressType: text(params, "spec.ipAddressType"),
    certificateArn: text(params, "spec.certificateArn"),
    sslPolicy: text(params, "spec.sslPolicy"),
    wafAcl:
      text(params, "spec.wafv2AclArn") ?? text(params, "spec.wafv2AclName"),
    inboundCidrs: strings(params, "spec.inboundCIDRs"),
    subnets: strings(params, "spec.subnets"),
    loadBalancerName: text(params, "spec.loadBalancerName"),
  };
}

/** One Ingress's place in a group, and the order it asked for. */
export interface Member {
  ingress: IngressInfo;
  /** `alb.ingress.kubernetes.io/group.order`, or `null` where unset. */
  order: number | null;
  hosts: string[];
}

export type AlbFinding =
  | {
      kind: "shared";
      severity: "warn";
      namespaces: string[];
    }
  | {
      kind: "order-clash";
      severity: "warn";
      order: number;
      members: string[];
    }
  | {
      kind: "disagree";
      severity: "warn";
      field: string;
      values: Array<{ value: string; by: string }>;
    }
  | { kind: "no-params"; severity: "err"; className: string; named: string };

export interface AlbGroup {
  /** The group's name, or `null` for an Ingress that owns its own ALB. */
  name: string | null;
  members: Member[];
  /** The params behind the class its members ask for, where one resolves. */
  params: Params | null;
  findings: AlbFinding[];
  worst: "err" | "warn" | null;
  /**
   * False where a member's class names an `IngressClassParams` nobody could
   * list: what it configures is unknown, and so, for a member with no group
   * annotation, is which load balancer it joins.
   */
  paramsKnown: boolean;
}

const orderOf = (ingress: IngressInfo): number | null => {
  const raw = ingress.annotations[GROUP_ORDER_ANNOTATION];
  if (raw === undefined) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const hostsOf = (ingress: IngressInfo): string[] =>
  ingress.rules.flatMap((rule) => (rule.host ? [rule.host] : []));

export interface GroupSources {
  ingresses: IngressInfo[];
  /** Every `IngressClassParams` in the cluster — the kind is cluster-scoped. */
  params: CustomResourceInfo[];
  /** Class name to the `IngressClassParams` its `spec.parameters` names. */
  classParams: Map<string, string>;
  /** Class names whose controller is the ALB controller. */
  ownClasses: string[];
  /** Kinds that could not be listed: a name into one is unresolved, not absent. */
  unread: ReadonlyArray<{ crd: string }>;
}

/**
 * The groups this cluster's ALB controller is running.
 *
 * An Ingress with no group annotation and no group on its class is its own
 * group of one — which is the ordinary case, and is drawn as itself rather
 * than as a degenerate group so nothing looks shared that is not.
 */
export function albGroups(sources: GroupSources): AlbGroup[] {
  const mine = claimed(sources.ingresses, sources.ownClasses);
  const paramsByName = new Map(
    sources.params.map((entry) => [entry.name, readParams(entry)] as const)
  );

  const paramsFor = (ingress: IngressInfo): Params | null => {
    const className = classOf(ingress);
    if (className === null) return null;
    const named = sources.classParams.get(className);
    return named ? (paramsByName.get(named) ?? null) : null;
  };

  const buckets = new Map<string, Member[]>();
  const groupParams = new Map<string, Params | null>();
  const missing = new Map<string, AlbFinding[]>();
  const unresolved = new Set<string>();
  const paramsListed = !sources.unread.some(
    (read) => read.crd === INGRESS_CLASS_PARAMS_CRD
  );

  for (const ingress of mine) {
    const params = paramsFor(ingress);
    const className = classOf(ingress);
    const named = className ? sources.classParams.get(className) : undefined;
    // The annotation wins over the class, which is how the controller reads
    // it: a per-Ingress group is an opt-in to somebody else's load balancer.
    const name =
      ingress.annotations[GROUP_NAME_ANNOTATION] ?? params?.group ?? null;
    const key = name ?? `\0${ingress.namespace}/${ingress.name}`;
    buckets.set(key, [
      ...(buckets.get(key) ?? []),
      { ingress, order: orderOf(ingress), hosts: hostsOf(ingress) },
    ]);
    if (!groupParams.has(key)) groupParams.set(key, params);

    if (!named || paramsByName.has(named)) continue;
    if (!paramsListed) {
      unresolved.add(key);
      continue;
    }
    const found = missing.get(key) ?? [];
    if (
      !found.some(
        (finding) => finding.kind === "no-params" && finding.named === named
      )
    ) {
      found.push({
        kind: "no-params",
        severity: "err",
        className: className!,
        named,
      });
    }
    missing.set(key, found);
  }

  const groups = [...buckets.entries()].map(([key, members]): AlbGroup => {
    const name = key.startsWith("\0") ? null : key;
    const findings: AlbFinding[] = [...(missing.get(key) ?? [])];

    const namespaces = [
      ...new Set(members.map((member) => member.ingress.namespace)),
    ].sort();
    // The fact the whole page exists for. One ALB, several namespaces, and
    // nothing on either Ingress's own page says the other one is there.
    if (name !== null && namespaces.length > 1) {
      findings.push({ kind: "shared", severity: "warn", namespaces });
    }

    // Two members claiming one order is the controller left to break the tie,
    // and which of them shadows the other is not stated anywhere.
    const byOrder = new Map<number, string[]>();
    for (const member of members) {
      if (member.order === null) continue;
      const at = byOrder.get(member.order) ?? [];
      at.push(`${member.ingress.namespace}/${member.ingress.name}`);
      byOrder.set(member.order, at);
    }
    for (const [order, clashing] of byOrder) {
      if (clashing.length > 1) {
        findings.push({
          kind: "order-clash",
          severity: "warn",
          order,
          members: clashing.sort(),
        });
      }
    }

    // A load balancer has one scheme. Two members asking for different ones
    // is a group where somebody's intent is silently discarded.
    for (const field of [SCHEME_ANNOTATION, CERTIFICATE_ARN_ANNOTATION]) {
      const values = new Map<string, string>();
      for (const member of members) {
        const value = member.ingress.annotations[field];
        if (value === undefined || value === "") continue;
        if (!values.has(value)) {
          values.set(
            value,
            `${member.ingress.namespace}/${member.ingress.name}`
          );
        }
      }
      if (values.size > 1) {
        findings.push({
          kind: "disagree",
          severity: "warn",
          field: field.slice(PREFIX.length),
          values: [...values.entries()].map(([value, by]) => ({ value, by })),
        });
      }
    }

    return {
      name,
      members: members.sort((left, right) => {
        if (left.order !== right.order) {
          if (left.order === null) return 1;
          if (right.order === null) return -1;
          return left.order - right.order;
        }
        return `${left.ingress.namespace}/${left.ingress.name}`.localeCompare(
          `${right.ingress.namespace}/${right.ingress.name}`
        );
      }),
      params: groupParams.get(key) ?? null,
      findings,
      worst: findings.some((finding) => finding.severity === "err")
        ? "err"
        : findings.length > 0
          ? "warn"
          : null,
      paramsKnown: !unresolved.has(key),
    };
  });

  // Shared load balancers first — they are the ones nothing else can show —
  // then by name, and an Ingress that owns its own ALB last.
  return groups.sort((left, right) => {
    if ((left.name === null) !== (right.name === null)) {
      return left.name === null ? 1 : -1;
    }
    if (left.members.length !== right.members.length) {
      return right.members.length - left.members.length;
    }
    return (left.name ?? "").localeCompare(right.name ?? "");
  });
}

/** A group's place in the list: unread parameters are not a clean bill. */
export function groupSeverity(
  group: AlbGroup
): "err" | "warn" | "unknown" | null {
  return group.worst ?? (group.paramsKnown ? null : "unknown");
}

/**
 * Whether the rows are the load balancers. An Ingress with no group of its
 * own whose parameters went unread may be on somebody else's.
 */
export function groupsKnown(groups: AlbGroup[]): boolean {
  return !groups.some((group) => group.name === null && !group.paramsKnown);
}

/** The sidebar's number: load balancers this controller is running. */
export function countGroups(sources: GroupSources): number | null {
  const groups = albGroups(sources);
  return groupsKnown(groups) ? groups.length : null;
}
