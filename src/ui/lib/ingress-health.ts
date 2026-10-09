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
import type {
  IngressClassBinding,
  IngressInfo,
  TlsCertificate,
} from "@/generated/types";
import {
  serviceHealthOf,
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
}

export type IngressProblem =
  | { kind: "noController"; className: string | null }
  | { kind: "backendMissing"; service: string }
  | { kind: "tlsSecretMissing"; secret: string }
  | { kind: "backendDown"; service: string }
  /** None ready, and every workload behind the backend is still starting its pods. */
  | { kind: "backendStarting"; service: string }
  /** None ready, and the pods the workloads behind the backend wait on were not read. */
  | { kind: "backendUnconfirmed"; service: string }
  /** Every workload behind the backend is scaled to zero, on purpose. */
  | { kind: "backendIdle"; service: string };

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

/** What each verdict of a backend Service says about the Ingress in front of it. */
const BACKEND_PROBLEM: Record<
  ServiceHealth["state"],
  Exclude<
    IngressProblem["kind"],
    "noController" | "backendMissing" | "tlsSecretMissing"
  > | null
> = {
  ready: null,
  partly: null,
  noneReady: "backendDown",
  noEndpoints: "backendDown",
  comingUp: "backendStarting",
  podsUnread: "backendUnconfirmed",
  idle: "backendIdle",
  externalName: null,
  selectorless: null,
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

  const names = backendNames(ingress);
  if (names.length > 0 && !backing.known) unread.push(backing.why);
  if (backing.known) {
    for (const name of names) {
      const service = backing.value.get(name);
      if (!service) {
        problems.push({ kind: "backendMissing", service: name });
        continue;
      }
      const health = serviceHealthOf(service, service, null);
      const problem = BACKEND_PROBLEM[health.state];
      if (problem) problems.push({ kind: problem, service: name });
    }
  }

  for (const config of ingress.tlsConfigs) {
    if (!config.secretName) continue;
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
      return t("readings", "healthBackendDown", { name: problem.service });
    case "backendStarting":
      return t("readings", "healthBackendStarting", { name: problem.service });
    case "backendUnconfirmed":
      return t("readings", "healthBackendUnconfirmed", {
        name: problem.service,
      });
    case "backendIdle":
      return t("readings", "healthBackendIdle", { name: problem.service });
  }
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
  backendIdle: "neutral",
};

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
      glyph: worst.kind === "backendUnconfirmed" ? EyeOff : undefined,
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
