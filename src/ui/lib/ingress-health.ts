/**
 * Whether an Ingress is served, as one verdict for its page, its peek and
 * the Ingresses list.
 *
 * Four things the YAML cannot show: no controller claims its class, a
 * backend Service that does not exist, a TLS Secret that does not exist, a
 * backend that publishes nothing. Each input carries whether it was read, so
 * an Ingress nobody could check is "not checked", never "serving".
 */

import { EyeOff } from "lucide-react";

import type { T } from "@/i18n/useT";
import type { Known } from "@/lib/known";
import {
  doorDoubt,
  doorWhy,
  refusedStop,
  type DoorAsk,
  type DoorDoubt,
} from "@/lib/policy-door";
import type {
  IngressClassBinding,
  IngressInfo,
  TlsCertificate,
} from "@/generated/types";
import {
  serviceHealthOf,
  serviceHealthWords,
  type ServiceHealth,
  type ServiceHealthInput,
  type Verdict,
} from "@/lib/service-health";
import type { StatusRole } from "@/lib/status-role";

/** One namespace's Services by name, as the Service verdict reads them. */
export type NamespaceBacking = ReadonlyMap<string, ServiceHealthInput>;

export interface IngressInputs {
  ingress: Pick<
    IngressInfo,
    | "name"
    | "namespace"
    | "className"
    | "rules"
    | "defaultBackend"
    | "tlsConfigs"
    | "loadBalancerIps"
  >;
  binding: Known<IngressClassBinding>;
  backing: Known<NamespaceBacking>;
  /** By Secret name; `undefined` until read. */
  certificates: Map<string, TlsCertificate> | undefined;
  /**
   * A host its controller serves as plain HTTP whatever `spec.tls` says, as
   * Traefik does without `router.tls`. Absent, `spec.tls` stands.
   */
  servedPlain?: (host: string) => boolean;
  /** Who the class's controller connects from; absent, no backend's NetworkPolicies are asked about it. */
  door?: DoorAsk;
}

export type IngressProblem =
  | { kind: "noController"; className: string | null }
  | { kind: "backendMissing"; service: string }
  | { kind: "tlsSecretMissing"; secret: string }
  /** Its Service's verdict rides along, so the Ingress says why too. */
  | { kind: "backendDown"; service: string; health: ServiceHealth }
  /** None ready, and every workload behind the backend is still starting its pods. */
  | { kind: "backendStarting"; service: string }
  /** None ready, and the pods the workloads behind the backend wait on were not read. */
  | { kind: "backendUnconfirmed"; service: string; health: ServiceHealth }
  /** Every workload behind the backend is scaled to zero, on purpose. */
  | { kind: "backendIdle"; service: string }
  /** Its pods are up, and whether their NetworkPolicies let the controller through is not known. */
  | { kind: "backendDoorUnchecked"; service: string; doubt: DoorDoubt };

export interface IngressHealth {
  problems: IngressProblem[];
  /** Why an input was not read; empty when every one was. */
  unread: Array<string | null>;
  backends: number;
  addressed: boolean;
}

/** Every Service the Ingress sends to, once each. */
export function backendNames(ingress: IngressInputs["ingress"]): string[] {
  const names = [
    ...ingress.rules.flatMap((rule) =>
      rule.paths.map((path) => path.backendService)
    ),
    ingress.defaultBackend?.backendService ?? "",
  ];
  return [...new Set(names.filter((name) => name !== ""))];
}

/** The Service ports an Ingress sends to on that Service. */
function backendPorts(
  ingress: IngressInputs["ingress"],
  service: string
): string[] {
  const paths = [
    ...ingress.rules.flatMap((rule) => rule.paths),
    ...(ingress.defaultBackend ? [ingress.defaultBackend] : []),
  ];
  return [
    ...new Set(
      paths
        .filter((path) => path.backendService === service)
        .map((path) => path.backendPort)
    ),
  ];
}

/** What each verdict of a backend Service says about the Ingress in front of it. */
const BACKEND_PROBLEM: Record<
  ServiceHealth["state"],
  Exclude<
    IngressProblem["kind"],
    | "noController"
    | "backendMissing"
    | "tlsSecretMissing"
    | "backendDoorUnchecked"
  > | null
> = {
  ready: null,
  partly: null,
  draining: null,
  noneReady: "backendDown",
  noEndpoints: "backendDown",
  shut: "backendDown",
  comingUp: "backendStarting",
  podsUnread: "backendUnconfirmed",
  idle: "backendIdle",
  externalName: null,
  selectorless: null,
  byHand: null,
  unknown: null,
};

export function ingressHealthOf(inputs: IngressInputs): IngressHealth {
  const { ingress, binding, backing, certificates } = inputs;
  const problems: IngressProblem[] = [];
  const unread: Array<string | null> = [];

  if (!binding.known) unread.push(binding.why);
  else if (!binding.value.resolved) {
    problems.push({ kind: "noController", className: ingress.className });
  }

  const controller = binding.known ? binding.value.controller : null;
  const read = controller ? inputs.door?.(controller) : undefined;
  const names = backendNames(ingress);
  if (names.length > 0 && !backing.known) unread.push(backing.why);
  if (backing.known) {
    for (const name of names) {
      const service = backing.value.get(name);
      if (!service) {
        problems.push({ kind: "backendMissing", service: name });
        continue;
      }
      const subject = {
        service: {
          kind: "Service",
          name,
          namespace: ingress.namespace,
          existence: "present" as const,
          facts: null,
        },
        stop: service.stop,
        door: service.door,
        ports: service.targets.map((port) => ({
          name: null,
          port,
          protocol: "TCP",
          exposed: true,
        })),
      };
      const ports = backendPorts(ingress, name);
      const refused = ports
        .map((port) => refusedStop(subject, port, read))
        .find((stop) => stop !== null);
      const health = serviceHealthOf(
        service,
        refused ? { ...service, stop: refused } : service,
        null
      );
      const problem = BACKEND_PROBLEM[health.state];
      if (problem === "backendDown" || problem === "backendUnconfirmed")
        problems.push({ kind: problem, service: name, health });
      else if (problem) problems.push({ kind: problem, service: name });
      else if (controller && inputs.door) {
        const doubt = ports
          .map((port) => doorDoubt(subject, port, read, controller))
          .find((found) => found !== null);
        if (doubt)
          problems.push({ kind: "backendDoorUnchecked", service: name, doubt });
      }
    }
  }

  for (const config of ingress.tlsConfigs) {
    if (!config.secretName) continue;
    // Never presented, so its absence breaks nothing a client sees; the
    // controller's own page says nothing of it either.
    if (
      config.hosts.length > 0 &&
      config.hosts.every((host) => inputs.servedPlain?.(host))
    )
      continue;
    if (!certificates) {
      unread.push(null);
      continue;
    }
    const problem = certificates.get(config.secretName)?.problem;
    if (problem?.says === "noSecret") {
      problems.push({ kind: "tlsSecretMissing", secret: config.secretName });
    } else if (problem?.says === "secretUnreadable") {
      unread.push(problem.said);
    }
  }

  return {
    problems,
    unread,
    backends: names.length,
    addressed: ingress.loadBalancerIps.length > 0,
  };
}

/**
 * What an Ingress's load balancer row can say: an address, one on its way
 * from a controller that serves the class, none because nothing serves it,
 * or nothing known because the class could not be read.
 */
export type IngressAddress =
  | "assigned"
  | "pending"
  | "noController"
  | "unknown";

export function ingressAddressOf(
  ingress: Pick<IngressInfo, "loadBalancerIps">,
  binding: IngressClassBinding | undefined
): IngressAddress {
  if (ingress.loadBalancerIps.length > 0) return "assigned";
  if (!binding) return "unknown";
  return binding.resolved ? "pending" : "noController";
}

/**
 * The class row, on the page and in the shared file: the class is a request
 * and the controller is who answers it, including "nobody does".
 */
export function ingressClassWords(
  className: string | null,
  binding: IngressClassBinding | undefined,
  t: T
): { text: string; tone: "err" | null } {
  if (!binding) {
    return { text: className || t("empty", "clusterDefault"), tone: null };
  }
  if (binding.resolved) {
    return {
      text: binding.controller
        ? `${binding.resolved} · ${binding.controller}`
        : binding.resolved,
      tone: null,
    };
  }
  return {
    text: className
      ? t("empty", "nothingServesClass", { name: className })
      : t("empty", "noClassNoDefault"),
    tone: "err",
  };
}

/** The words and tone of each state without an address. */
export const INGRESS_ADDRESS_WORDS: Record<
  Exclude<IngressAddress, "assigned">,
  {
    key: "pendingInline" | "addressNoController" | "unknownLower";
    tone: "warn" | "err" | null;
  }
> = {
  pending: { key: "pendingInline", tone: "warn" },
  noController: { key: "addressNoController", tone: "err" },
  unknown: { key: "unknownLower", tone: null },
};

const ORDER: IngressProblem["kind"][] = [
  "noController",
  "backendMissing",
  "tlsSecretMissing",
  "backendDown",
  "backendStarting",
  "backendUnconfirmed",
  "backendDoorUnchecked",
  "backendIdle",
];

function problemSentence(problem: IngressProblem, t: T): string {
  switch (problem.kind) {
    case "noController":
      return problem.className
        ? t("readings", "healthNothingServesClass", { name: problem.className })
        : t("readings", "healthNoClassNoDefault");
    case "backendMissing":
      return t("nav", "stopNoServiceNamed", { name: problem.service });
    case "tlsSecretMissing":
      return t("readings", "healthNoTlsSecret", { name: problem.secret });
    case "backendDown":
      return backendWhy(problem, "healthBackendDown", t);
    case "backendStarting":
      return t("readings", "healthBackendStarting", { name: problem.service });
    case "backendUnconfirmed":
      return backendWhy(problem, "healthBackendUnconfirmed", t);
    case "backendIdle":
      return t("readings", "healthBackendIdle", { name: problem.service });
    case "backendDoorUnchecked": {
      const said = {
        name: problem.service,
        client: problem.doubt.client,
        why: doorWhy(problem.doubt, t),
      };
      const n = problem.doubt.policies.length;
      const names = problem.doubt.policies.join(", ");
      if (problem.doubt.side === "client")
        return n === 0
          ? t("readings", "healthBackendEgressUnread", said)
          : t("count", "healthBackendEgressUnchecked", { ...said, n, names });
      return n === 0
        ? t("readings", "healthBackendPoliciesUnread", said)
        : t("count", "healthBackendDoorUnchecked", { ...said, n, names });
    }
  }
}

/** A backend's trouble in its Service's own words, where its verdict has any. */
function backendWhy(
  problem: { service: string; health: ServiceHealth },
  plain: "healthBackendDown" | "healthBackendUnconfirmed",
  t: T
): string {
  const why = serviceHealthWords(problem.health, t).reason;
  return why
    ? t("readings", "healthBackendWhy", { name: problem.service, why })
    : t("readings", plain, { name: problem.service });
}

const PROBLEM_LABEL: Record<
  IngressProblem["kind"],
  | "healthNoController"
  | "healthMissingBackend"
  | "healthMissingTlsSecret"
  | "healthBackendDownShort"
  | "healthBackendStartingShort"
  | "healthBackendUnconfirmedShort"
  | "healthBackendIdleShort"
> = {
  noController: "healthNoController",
  backendMissing: "healthMissingBackend",
  tlsSecretMissing: "healthMissingTlsSecret",
  backendDown: "healthBackendDownShort",
  backendStarting: "healthBackendStartingShort",
  backendUnconfirmed: "healthBackendUnconfirmedShort",
  backendDoorUnchecked: "healthBackendUnconfirmedShort",
  backendIdle: "healthBackendIdleShort",
};

/** The colour a problem is drawn in where it is the worst one. */
const PROBLEM_ROLE: Record<IngressProblem["kind"], StatusRole> = {
  noController: "err",
  backendMissing: "err",
  tlsSecretMissing: "err",
  backendDown: "err",
  backendStarting: "pending",
  backendUnconfirmed: "neutral",
  backendDoorUnchecked: "neutral",
  backendIdle: "neutral",
};

/** Problems nobody could confirm or rule out. */
const UNCONFIRMED: ReadonlySet<IngressProblem["kind"]> = new Set([
  "backendUnconfirmed",
  "backendDoorUnchecked",
]);

/** Every label `ingressHealthWords` can draw, for the column that has to hold the widest. */
export const ingressVerdictLabels = (t: T) => [
  ...Object.values(PROBLEM_LABEL).map((key) => t("readings", key)),
  t("nav", "notChecked"),
  t("readings", "healthStillReading"),
  t("readings", "healthNoAddressYet"),
  t("readings", "healthServed"),
];

export function ingressHealthWords(health: IngressHealth, t: T): Verdict {
  const problems = [...health.problems].sort(
    (a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind)
  );
  const worst = problems[0];
  if (worst) {
    const down = problems.filter(
      (problem) => problem.kind === "backendDown"
    ).length;
    // A path that still reaches a backend is degraded, not dead.
    const partial = worst.kind === "backendDown" && down < health.backends;
    return {
      code: worst.kind,
      label: t("readings", PROBLEM_LABEL[worst.kind]),
      role: partial ? "warn" : PROBLEM_ROLE[worst.kind],
      glyph: UNCONFIRMED.has(worst.kind) ? EyeOff : undefined,
      reason: `${problems.map((problem) => problemSentence(problem, t)).join(". ")}.`,
    };
  }
  if (health.unread.length > 0) {
    const said = health.unread.filter((why): why is string => why !== null);
    return said.length > 0
      ? {
          code: "unknown",
          label: t("nav", "notChecked"),
          role: "neutral",
          reason: said.join(". "),
        }
      : {
          code: "reading",
          label: t("readings", "healthStillReading"),
          role: "neutral",
          reason: null,
        };
  }
  if (!health.addressed) {
    return {
      code: "waiting",
      label: t("readings", "healthNoAddressYet"),
      role: "pending",
      reason: t("readings", "healthNoAddressYetWhy"),
    };
  }
  return {
    code: "serving",
    label: t("readings", "healthServed"),
    role: "ok",
    reason: null,
  };
}

export const secretNamesOf = (ingress: Pick<IngressInfo, "tlsConfigs">) =>
  ingress.tlsConfigs.flatMap((config) =>
    config.secretName ? [config.secretName] : []
  );
