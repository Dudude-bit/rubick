/**
 * Whether an Ingress is served, as one verdict for its page, its peek and
 * the Ingresses list.
 *
 * Four things the YAML cannot show: no controller claims its class, a
 * backend Service that does not exist, a TLS Secret that does not exist, a
 * backend that publishes nothing. Each input carries whether it was read, so
 * an Ingress nobody could check is "not checked", never "serving".
 */

import type { T } from "@/i18n/useT";
import type { Known } from "@/lib/known";
import type {
  IngressClassBinding,
  IngressInfo,
  ServiceInfo,
  ServicePublished,
  TlsCertificate,
} from "@/generated/types";
import { serviceHealthOf, type Verdict } from "@/lib/service-health";

export interface NamespaceBacking {
  services: ServiceInfo[];
  published: ServicePublished[];
}

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
  | { kind: "backendDown"; service: string };

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
      const service = backing.value.services.find(
        (entry) => entry.name === name && entry.namespace === ingress.namespace
      );
      if (!service) {
        problems.push({ kind: "backendMissing", service: name });
        continue;
      }
      const published = backing.value.published.find(
        (entry) =>
          entry.service.name === name &&
          entry.service.namespace === ingress.namespace
      );
      const health = serviceHealthOf(
        {
          type: service.type,
          selectorless: Object.keys(service.selector).length === 0,
        },
        published,
        null
      );
      if (health.state === "noEndpoints" || health.state === "noneReady") {
        problems.push({ kind: "backendDown", service: name });
      }
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

const ORDER: IngressProblem["kind"][] = [
  "noController",
  "backendMissing",
  "tlsSecretMissing",
  "backendDown",
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
  }
}

const PROBLEM_LABEL: Record<
  IngressProblem["kind"],
  | "healthNoController"
  | "healthMissingBackend"
  | "healthMissingTlsSecret"
  | "healthBackendDownShort"
> = {
  noController: "healthNoController",
  backendMissing: "healthMissingBackend",
  tlsSecretMissing: "healthMissingTlsSecret",
  backendDown: "healthBackendDownShort",
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
      role: partial ? "warn" : "err",
      reason: problems.map((problem) => problemSentence(problem, t)).join(". "),
    };
  }
  if (health.unread.length > 0) {
    const said = health.unread.filter((why): why is string => why !== null);
    return {
      code: "unknown",
      label: t("nav", "notChecked"),
      role: "neutral",
      reason:
        said.length > 0 ? said.join(". ") : t("readings", "healthStillReading"),
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
