import contract from "../../../../../contracts/audit-rules.json";
import type {
  AuditSeverity,
  Category,
  RuleId,
  Unchecked,
  What,
  Why,
} from "@/generated/types";
import type { en } from "@/i18n/catalogue";
import type { T } from "@/i18n/useT";
import { formatBytes, formatCPU } from "@/lib/k8s-quantity";
import { formatAge, formatWhen } from "@/lib/utils";

type AuditKey = keyof typeof en.audit;

export interface RuleMeta {
  category: Category;
  severity: AuditSeverity;
  standard: "baseline" | "restricted" | null;
}

/** Each rule's category, usual severity and standard, from the file the backend judges with. */
export const RULE_META = Object.fromEntries(
  contract.rules.map((rule) => [
    rule.id,
    {
      category: rule.category,
      severity: rule.severity,
      standard: rule.standard,
    },
  ])
) as Record<RuleId, RuleMeta>;

/** In the order the backend declares them. */
export const RULE_IDS = contract.rules.map((rule) => rule.id as RuleId);

/** The kind a Helm release is filed under as an audited subject: no Kubernetes kind holds a dot. */
export const HELM_RELEASE = contract.helmRelease;

/** The kind a deprecated API the server was asked for is filed under. */
export const DEPRECATED_API = contract.deprecatedApi;

/** Every rule's title and why, a total map the compiler holds to the generated union. */
export const RULE_WORDS: Record<RuleId, { title: AuditKey; why: AuditKey }> = {
  "pss-host-process": { title: "pssHostProcess", why: "pssHostProcessWhy" },
  "pss-host-namespaces": {
    title: "pssHostNamespaces",
    why: "pssHostNamespacesWhy",
  },
  "pss-privileged": { title: "pssPrivileged", why: "pssPrivilegedWhy" },
  "pss-capabilities": { title: "pssCapabilities", why: "pssCapabilitiesWhy" },
  "pss-host-path": { title: "pssHostPath", why: "pssHostPathWhy" },
  "pss-host-ports": { title: "pssHostPorts", why: "pssHostPortsWhy" },
  "pss-host-probes": { title: "pssHostProbes", why: "pssHostProbesWhy" },
  "pss-apparmor": { title: "pssApparmor", why: "pssApparmorWhy" },
  "pss-selinux": { title: "pssSelinux", why: "pssSelinuxWhy" },
  "pss-proc-mount": { title: "pssProcMount", why: "pssProcMountWhy" },
  "pss-seccomp-unconfined": {
    title: "pssSeccompUnconfined",
    why: "pssSeccompUnconfinedWhy",
  },
  "pss-sysctls": { title: "pssSysctls", why: "pssSysctlsWhy" },
  "pss-volume-types": { title: "pssVolumeTypes", why: "pssVolumeTypesWhy" },
  "pss-privilege-escalation": {
    title: "pssPrivilegeEscalation",
    why: "pssPrivilegeEscalationWhy",
  },
  "pss-run-as-non-root": {
    title: "pssRunAsNonRoot",
    why: "pssRunAsNonRootWhy",
  },
  "pss-run-as-user-root": {
    title: "pssRunAsUserRoot",
    why: "pssRunAsUserRootWhy",
  },
  "pss-seccomp-required": {
    title: "pssSeccompRequired",
    why: "pssSeccompRequiredWhy",
  },
  "pss-drop-capabilities": {
    title: "pssDropCapabilities",
    why: "pssDropCapabilitiesWhy",
  },
  "runtime-socket": { title: "runtimeSocket", why: "runtimeSocketWhy" },
  "config-map-private-key": {
    title: "configMapPrivateKey",
    why: "configMapPrivateKeyWhy",
  },
  "env-secret-literal": {
    title: "envSecretLiteral",
    why: "envSecretLiteralWhy",
  },
  "writable-root-filesystem": {
    title: "writableRootFilesystem",
    why: "writableRootFilesystemWhy",
  },
  "cluster-admin-binding": {
    title: "clusterAdminBinding",
    why: "clusterAdminBindingWhy",
  },
  "wildcard-role": { title: "wildcardRole", why: "wildcardRoleWhy" },
  "default-service-account-token": {
    title: "defaultServiceAccountToken",
    why: "defaultServiceAccountTokenWhy",
  },
  "namespace-without-network-policy": {
    title: "namespaceWithoutNetworkPolicy",
    why: "namespaceWithoutNetworkPolicyWhy",
  },
  "no-readiness-probe": {
    title: "noReadinessProbe",
    why: "noReadinessProbeWhy",
  },
  "no-liveness-probe": { title: "noLivenessProbe", why: "noLivenessProbeWhy" },
  "image-tag-latest": { title: "imageTagLatest", why: "imageTagLatestWhy" },
  "single-replica": { title: "singleReplica", why: "singleReplicaWhy" },
  "no-disruption-budget": {
    title: "noDisruptionBudget",
    why: "noDisruptionBudgetWhy",
  },
  "budget-blocks-disruption": {
    title: "budgetBlocksDisruption",
    why: "budgetBlocksDisruptionWhy",
  },
  "no-spread": { title: "noSpread", why: "noSpreadWhy" },
  "no-memory-limit": { title: "noMemoryLimit", why: "noMemoryLimitWhy" },
  "autoscaler-pinned": {
    title: "autoscalerPinned",
    why: "autoscalerPinnedWhy",
  },
  "autoscaler-target-missing": {
    title: "autoscalerTargetMissing",
    why: "autoscalerTargetMissingWhy",
  },
  "no-cpu-request": { title: "noCpuRequest", why: "noCpuRequestWhy" },
  "no-memory-request": { title: "noMemoryRequest", why: "noMemoryRequestWhy" },
  "removed-api-in-helm-release": {
    title: "removedApiInHelmRelease",
    why: "removedApiInHelmReleaseWhy",
  },
  "deprecated-api-writer": {
    title: "deprecatedApiWriter",
    why: "deprecatedApiWriterWhy",
  },
  "crd-version-deprecated": {
    title: "crdVersionDeprecated",
    why: "crdVersionDeprecatedWhy",
  },
  "deprecated-api-requested": {
    title: "deprecatedApiRequested",
    why: "deprecatedApiRequestedWhy",
  },
  "requests-above-usage": {
    title: "requestsAboveUsage",
    why: "requestsAboveUsageWhy",
  },
};

export const ruleTitle = (rule: RuleId, t: T) =>
  t("audit", RULE_WORDS[rule].title);

export const ruleWhy = (rule: RuleId, t: T) => t("audit", RULE_WORDS[rule].why);

export const SEVERITY_WORDS: Record<AuditSeverity, AuditKey> = {
  high: "high",
  medium: "medium",
  low: "low",
};

export const SEVERITY_TONE: Record<AuditSeverity, "err" | "warn" | "info"> = {
  high: "err",
  medium: "warn",
  low: "info",
};

export const CATEGORY_WORDS: Record<Category, AuditKey> = {
  security: "security",
  reliability: "reliability",
  efficiency: "efficiency",
  upgrade: "upgrade",
};

export const SEVERITIES: AuditSeverity[] = ["high", "medium", "low"];
export const CATEGORIES: Category[] = [
  "security",
  "reliability",
  "efficiency",
  "upgrade",
];

export const standardWords = (rule: RuleId, t: T) => {
  const standard = RULE_META[rule].standard;
  return standard ? t("audit", standard) : "";
};

const WHY_WORDS: {
  [K in Why["says"]]: (why: Extract<Why, { says: K }>, t: T) => string;
} = {
  reading: (_, t) => t("audit", "whyReading"),
  queued: (_, t) => t("audit", "whyQueued"),
  refused: (why, t) => t("audit", "whyRefused", { message: why.message }),
  failed: (why, t) => t("audit", "whyFailed", { message: why.message }),
  notAudited: (_, t) => t("audit", "whyNotAudited"),
  unserved: (_, t) => t("audit", "whyUnserved"),
  noPrometheus: (_, t) => t("audit", "whyNoPrometheus"),
  notScraped: (_, t) => t("audit", "whyNotScraped"),
  noUsage: (_, t) => t("audit", "whyNoUsage"),
  noSamples: (_, t) => t("audit", "whyNoSamples"),
  peakUnread: (_, t) => t("audit", "whyPeakUnread"),
  young: (why, t) =>
    why.says === "young" && why.since !== null
      ? t("audit", "whyYoung", { age: formatAge(why.since, t) })
      : t("audit", "whyYoungUndated"),
  partial: (why, t) => t("audit", "whyPartial", { read: why.read, n: why.of }),
  folded: (_, t) => t("audit", "whyFolded"),
  admitted: (why, t) =>
    t("audit", "whyAdmitted", { webhooks: why.webhooks.join(", ") }),
};

/** Why a kind was not read, worded. */
export function whyWords(why: Why, t: T): string {
  return (WHY_WORDS[why.says] as (why: Why, t: T) => string)(why, t);
}

/** "PodDisruptionBudget in shop: refused: …" for a rule one object could not answer. */
export function uncheckedWords(unchecked: Unchecked, t: T): string {
  return unchecked.namespace
    ? t("audit", "notCheckedIn", {
        kind: unchecked.kind,
        namespace: unchecked.namespace,
        why: whyWords(unchecked.why, t),
      })
    : t("audit", "notCheckedAcross", {
        kind: unchecked.kind,
        why: whyWords(unchecked.why, t),
      });
}

/** The catalogue key and values one value of a finding is said with. */
export interface Said {
  key: AuditKey;
  values: Record<string, string | number>;
}

const containerKey = {
  containers: "container",
  initContainers: "initContainer",
  ephemeralContainers: "ephemeralContainer",
} as const satisfies Record<string, AuditKey>;

/** "container web", "init container migrate", or "the pod". */
export function atWords(
  at: Extract<What, { says: "set" }>["at"],
  t: T
): string {
  return at
    ? t("audit", containerKey[at.list], { name: at.container })
    : t("audit", "thePod");
}

const NET_WORDS = {
  privateKey: "netContent",
  keyName: "netName",
  declared: "netDeclared",
  helmRelease: "netHelm",
} as const satisfies Record<string, AuditKey>;

const SAYS: {
  [K in What["says"]]: (what: Extract<What, { says: K }>, t: T) => Said;
} = {
  set: (w, t) => ({
    key: "wSet",
    values: { at: atWords(w.at, t), field: w.field, value: w.value },
  }),
  unset: (w, t) => ({
    key: "wUnset",
    values: { at: atWords(w.at, t), field: w.field },
  }),
  volume: (w): Said =>
    w.path !== null
      ? { key: "wHostPath", values: { volume: w.volume, path: w.path } }
      : { key: "wVolume", values: { volume: w.volume, source: w.source } },
  socket: (w) => ({
    key: "wSocket",
    values: { volume: w.volume, path: w.path, socket: w.socket },
  }),
  envLiteral: (w, t) => ({
    key: "wEnvLiteral",
    values: { at: atWords(w.at, t), variable: w.variable },
  }),
  key: (w, t) => ({
    key: "wKey",
    values: { key: w.key, net: t("audit", NET_WORDS[w.net.says]) },
  }),
  image: (w, t) => ({
    key: "wImage",
    values: { at: atWords(w.at, t), image: w.image },
  }),
  replicas: (w): Said =>
    w.autoscaler !== null
      ? {
          key: "wReplicasBy",
          values: { n: w.replicas, autoscaler: w.autoscaler },
        }
      : { key: "wReplicas", values: { n: w.replicas } },
  budget: (w) => ({
    key: "wBudget",
    values: { required: w.required, selected: w.selected },
  }),
  token: (w) => ({
    key:
      w.by === "pod"
        ? "wTokenPod"
        : w.by === "account"
          ? "wTokenAccount"
          : "wTokenDefault",
    values: {},
  }),
  subject: (w): Said =>
    w.namespace !== null
      ? {
          key: "wSubjectIn",
          values: {
            role: w.role,
            kind: w.kind,
            name: w.name,
            namespace: w.namespace,
          },
        }
      : {
          key: "wSubject",
          values: { role: w.role, kind: w.kind, name: w.name },
        },
  wildcard: (w, t) => ({
    key: "wWildcard",
    values: {
      groups: w.groups
        .map((group) => (group === "" ? t("audit", "wCoreGroup") : group))
        .join(", "),
    },
  }),
  range: (w) => ({ key: "wRange", values: { min: w.min, max: w.max } }),
  target: (w) => ({ key: "wTarget", values: { kind: w.kind, name: w.name } }),
  pods: (w) => ({ key: "wPods", values: { n: w.pods } }),
  traffic: (w, t): Said =>
    w.by.says === "service"
      ? { key: "wTrafficService", values: { name: w.by.name } }
      : w.by.says === "noService"
        ? { key: "wTrafficNone", values: {} }
        : {
            key: "wTrafficUnread",
            values: { why: whyWords(w.by.why, t) },
          },
  revision: (w) => ({
    key: "wRevision",
    values: { revision: w.revision, status: w.status },
  }),
  stored: (w): Said => {
    const values = { kind: w.kind, name: w.name, api: w.api };
    if (w.removal === null) return { key: "wStoredUnserved", values };
    return {
      key: w.served ? "wStoredDue" : "wStoredGone",
      values: { ...values, removed: w.removal.removed },
    };
  },
  written: (w): Said => {
    const values = {
      manager: w.manager,
      api: w.api,
      removed: w.removal.removed,
    };
    return w.time === null
      ? { key: "wWrittenUndated", values }
      : {
          key: "wWritten",
          values: { ...values, time: formatWhen(w.time, "moment") },
        };
  },
  deprecated: (w): Said =>
    w.warning === null
      ? { key: "wDeprecatedQuiet", values: { version: w.version } }
      : {
          key: "wDeprecatedWarned",
          values: { version: w.version, warning: w.warning },
        },
  storedAs: (w): Said => {
    const stored = w.stored.join(", ");
    if (w.storage === null)
      return { key: "wStoredAsUnknown", values: { kind: w.kind, stored } };
    return w.stored.length === 0
      ? { key: "wStoredAsOnly", values: { kind: w.kind, storage: w.storage } }
      : {
          key: "wStoredAs",
          values: { kind: w.kind, storage: w.storage, stored },
        };
  },
  requested: (w): Said =>
    w.removed === null
      ? { key: "wRequestedUndated", values: {} }
      : { key: "wRequested", values: { removed: w.removed } },
  requestedToday: (w): Said =>
    w.requests === 0
      ? { key: "wRequestedTodayNone", values: {} }
      : { key: "wRequestedToday", values: { n: w.requests } },
  overRequested: (w, t): Said => {
    const cpu = w.resource === "cpu";
    const amount = (n: number) => (cpu ? formatCPU(n) : formatBytes(n));
    return {
      key: w.at_most ? "wOverRequestedAtMost" : "wOverRequested",
      values: {
        resource: t("audit", cpu ? "wCpu" : "wMemory"),
        peak: amount(w.peak),
        requested: amount(w.requested),
      },
    };
  },
};

/** What one value of a finding says, as a key and its values. */
export function said(what: What, t: T): Said {
  return (SAYS[what.says] as (what: What, t: T) => Said)(what, t);
}

/** The same, as one plain line: what Share writes. */
export function whatWords(what: What, t: T): string {
  const { key, values } = said(what, t);
  return t("audit", key, values);
}

/** The values a sentence names that came from the object, drawn apart. */
export const VERBATIM = new Set([
  "field",
  "value",
  "variable",
  "image",
  "path",
  "socket",
  "volume",
  "key",
  "role",
  "name",
  "groups",
  "autoscaler",
  "api",
  "manager",
  "status",
  "version",
  "warning",
  "storage",
  "stored",
]);
