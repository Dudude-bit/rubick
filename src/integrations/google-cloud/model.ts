/**
 * What GKE's three Ingress objects say, read once for every surface that
 * asks.
 *
 * The split worth stating up front, because everything else here follows
 * from it: **`BackendConfig` and `FrontendConfig` have no status at all.**
 * Not an empty one that a controller has not filled in yet — the types are
 * declared `+genclient:noStatus` upstream and their CRDs carry a `status`
 * object with no properties in it. So nothing drawn from them may ever read
 * as a verdict. They state what the Google load balancer *will be told*: a
 * health check to run, a timeout to enforce, CDN to turn on. Whether that
 * health check passes is a question for the cloud's API and is not in this
 * cluster.
 *
 * `ManagedCertificate` is the opposite and is the reason this tier is worth
 * anything: its controller writes a real status, per domain, and
 * `FailedNotVisible` on one domain of four is the single most common way a
 * GKE Ingress serves a certificate nobody can use. The vocabulary below is
 * the controller's own, not a guess at it.
 */

import type { CustomResourceInfo } from "@/generated/types";
import { getValueByPath } from "../kit";

export const BACKEND_CONFIG_CRD = "backendconfigs.cloud.google.com";
export const FRONTEND_CONFIG_CRD = "frontendconfigs.networking.gke.io";
export const MANAGED_CERTIFICATE_CRD = "managedcertificates.networking.gke.io";

/**
 * The annotation a Service names its `BackendConfig`s in, current spelling
 * first. The `beta.` one predates GA and is still what an older Service
 * carries; both are read because a cluster upgraded in place keeps whichever
 * it was written with.
 */
export const BACKEND_CONFIG_ANNOTATIONS = [
  "cloud.google.com/backend-config",
  "beta.cloud.google.com/backend-config",
] as const;

/**
 * The Ingress annotations GKE reads, and the reason this vendor has a page.
 *
 * Each one is an edge from the routing table to an object that is otherwise
 * an anonymous row on a list page. GKE is also explicit that it reads
 * `kubernetes.io/ingress.class` and **ignores `spec.ingressClassName`** — the
 * opposite of every other controller in this tree, and the difference
 * between an Ingress that is served and one that is silently not.
 */
export const INGRESS_CLASS_ANNOTATION = "kubernetes.io/ingress.class";
export const FRONTEND_CONFIG_ANNOTATION =
  "networking.gke.io/v1beta1.FrontendConfig";
export const MANAGED_CERTIFICATES_ANNOTATION =
  "networking.gke.io/managed-certificates";
export const PRE_SHARED_CERT_ANNOTATION =
  "ingress.gcp.kubernetes.io/pre-shared-cert";
export const STATIC_IP_ANNOTATION =
  "kubernetes.io/ingress.global-static-ip-name";
export const ALLOW_HTTP_ANNOTATION = "kubernetes.io/ingress.allow-http";
export const NEG_ANNOTATION = "cloud.google.com/neg";

/** The classes GKE's own controller answers to. */
const GCE_CLASSES = new Set(["gce", "gce-internal", "gce-regional-external"]);

/** Which GKE load balancer this Ingress asks for, or `null` for somebody else's. */
export function gceClassOf(annotations: Record<string, string>): string | null {
  const value = annotations[INGRESS_CLASS_ANNOTATION];
  return value !== undefined && GCE_CLASSES.has(value) ? value : null;
}

export function frontendConfigRef(
  annotations: Record<string, string>
): string | null {
  const value = annotations[FRONTEND_CONFIG_ANNOTATION];
  return value !== undefined && value !== "" ? value : null;
}

const commaList = (value: string | undefined): string[] =>
  value === undefined
    ? []
    : value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");

export function managedCertificateRefs(
  annotations: Record<string, string>
): string[] {
  return commaList(annotations[MANAGED_CERTIFICATES_ANNOTATION]);
}

export function preSharedCerts(annotations: Record<string, string>): string[] {
  return commaList(annotations[PRE_SHARED_CERT_ANNOTATION]);
}

export function staticIpName(
  annotations: Record<string, string>
): string | null {
  const value = annotations[STATIC_IP_ANNOTATION];
  return value !== undefined && value !== "" ? value : null;
}

/**
 * Whether GKE gives this Ingress an HTTP listener at all.
 *
 * Defaults to true, and the `"false"` case is the point: GKE then creates no
 * port-80 forwarding rule whatsoever. "Why does http:// time out while
 * https:// works" has no symptom anywhere in the cluster — the Ingress is
 * healthy, the Service is healthy, and one line of metadata deleted the
 * listener.
 */
export function allowsHttp(annotations: Record<string, string>): boolean {
  return annotations[ALLOW_HTTP_ANNOTATION] !== "false";
}

/**
 * Whether a Service asked for container-native load balancing for Ingress.
 *
 * `'{"ingress": true}'`. Worth showing because the alternative is GKE routing
 * through the node's kube-proxy — a second hop, and health checks that report
 * on the node rather than on the pod.
 */
export function negForIngress(annotations: Record<string, string>): boolean {
  const raw = annotations[NEG_ANNOTATION];
  if (raw === undefined) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { ingress?: unknown }).ingress === true
    );
  } catch {
    return false;
  }
}

/** One `BackendConfig` a Service asks for, and what it asked for it by. */
export interface BackendConfigRef {
  name: string;
  /** `null` for the `default` key — every port — or the port it applies to. */
  port: string | null;
}

/**
 * The `BackendConfig`s a Service names, from its annotation.
 *
 * The value is JSON — `{"default":"cfg"}` or `{"ports":{"80":"cfg-80"}}` —
 * and a Service whose annotation does not parse is reported as naming
 * nothing rather than as naming something odd. A malformed annotation means
 * GKE applied no config either, so "none" is the true answer and not a
 * fallback.
 */
export function backendConfigRefs(
  annotations: Record<string, string>
): BackendConfigRef[] {
  for (const key of BACKEND_CONFIG_ANNOTATIONS) {
    const raw = annotations[key];
    if (raw === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (typeof parsed !== "object" || parsed === null) return [];
    const value = parsed as { default?: unknown; ports?: unknown };
    const refs: BackendConfigRef[] = [];
    if (typeof value.default === "string" && value.default !== "") {
      refs.push({ name: value.default, port: null });
    }
    if (typeof value.ports === "object" && value.ports !== null) {
      for (const [port, name] of Object.entries(
        value.ports as Record<string, unknown>
      )) {
        if (typeof name === "string" && name !== "") refs.push({ name, port });
      }
    }
    return refs;
  }
  return [];
}

const text = (resource: CustomResourceInfo, path: string): string | null => {
  const value = getValueByPath(resource, path);
  return typeof value === "string" && value !== "" ? value : null;
};

const number = (resource: CustomResourceInfo, path: string): number | null => {
  const value = getValueByPath(resource, path);
  return typeof value === "number" ? value : null;
};

const flag = (resource: CustomResourceInfo, path: string): boolean =>
  getValueByPath(resource, path) === true;

/**
 * The health check a `BackendConfig` asks Google to run, as one clause.
 *
 * Every field is optional in the CRD and GKE fills the rest in from the
 * backend's own port and from its defaults, so only what was actually
 * written is printed — a path this object does not set is not `/`, it is a
 * path this object does not set.
 */
export function healthCheckOf(config: CustomResourceInfo): string | null {
  const type = text(config, "spec.healthCheck.type");
  const port = number(config, "spec.healthCheck.port");
  const path = text(config, "spec.healthCheck.requestPath");
  if (type === null && port === null && path === null) return null;
  const where = [port === null ? null : `:${port}`, path]
    .filter(Boolean)
    .join("");
  return ["health check", type, where].filter(Boolean).join(" ");
}

/**
 * How fast a failing backend is taken out, and how fast it comes back.
 *
 * The four numbers people actually open a `BackendConfig` for, and the
 * summary line has never carried them: an interval of 5s with an unhealthy
 * threshold of 2 takes a backend out in ten seconds, and 60s with a
 * threshold of 10 takes ten minutes. Both read as "health check HTTP /" in
 * one line.
 *
 * `null` per field where the object does not set it — GKE then fills in its
 * own default, and printing that default here would attribute a number to an
 * object that never stated one.
 */
export interface HealthCheckTiming {
  intervalSec: number | null;
  timeoutSec: number | null;
  healthyThreshold: number | null;
  unhealthyThreshold: number | null;
}

export function healthCheckTiming(
  config: CustomResourceInfo
): HealthCheckTiming {
  return {
    intervalSec: number(config, "spec.healthCheck.checkIntervalSec"),
    timeoutSec: number(config, "spec.healthCheck.timeoutSec"),
    healthyThreshold: number(config, "spec.healthCheck.healthyThreshold"),
    unhealthyThreshold: number(config, "spec.healthCheck.unhealthyThreshold"),
  };
}

/** The Secret an IAP-protected backend reads its OAuth client from. */
export function iapSecretName(config: CustomResourceInfo): string | null {
  return text(config, "spec.iap.oauthclientCredentials.secretName");
}

/** Headers this backend injects, which are otherwise invisible anywhere. */
export function customHeaders(config: CustomResourceInfo): {
  request: string[];
  response: string[];
} {
  const list = (path: string): string[] => {
    const value = getValueByPath(config, path);
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  };
  return {
    request: list("spec.customRequestHeaders.headers"),
    response: list("spec.customResponseHeaders.headers"),
  };
}

/**
 * What Cloud CDN was actually told, when it is on.
 *
 * `cdn.enabled: true` alone says nothing about what is cached or for how
 * long, and `cacheMode: CACHE_ALL_STATIC` versus `FORCE_CACHE_ALL` is the
 * difference between caching images and caching an authenticated response
 * for everybody.
 */
export function cdnOf(
  config: CustomResourceInfo
): { mode: string | null; detail: string | null } | null {
  if (!flag(config, "spec.cdn.enabled")) return null;
  const details = [
    number(config, "spec.cdn.defaultTtl") === null
      ? null
      : `default ${number(config, "spec.cdn.defaultTtl")}s`,
    number(config, "spec.cdn.maxTtl") === null
      ? null
      : `max ${number(config, "spec.cdn.maxTtl")}s`,
    flag(config, "spec.cdn.negativeCaching") ? "caches errors" : null,
    flag(config, "spec.cdn.requestCoalescing") ? "coalesces" : null,
  ].filter(Boolean);
  return {
    mode: text(config, "spec.cdn.cacheMode"),
    detail: details.length > 0 ? details.join(" · ") : null,
  };
}

export function cdnSummary(config: CustomResourceInfo): string | null {
  const cdn = cdnOf(config);
  if (!cdn) return null;
  const parts = [cdn.mode, cdn.detail].filter(Boolean);
  return parts.length > 0 ? `CDN ${parts.join(" · ")}` : "CDN on";
}

/**
 * Everything a `BackendConfig` turns on, in one line for a chain hop.
 *
 * Ordered by how much it changes what a request does rather than by the
 * order of the spec: a failing health check takes the backend out, a
 * timeout ends a request, and CDN and IAP change who is answered.
 */
export function backendConfigSummary(
  config: CustomResourceInfo,
  // `cdn: false` is for the chain, where the edge cache is its own hop and
  // saying it twice would bury the rest of the line again.
  options: { cdn?: boolean } = {}
): string {
  const timeout = number(config, "spec.timeoutSec");
  const draining = number(config, "spec.connectionDraining.drainingTimeoutSec");
  const affinity = text(config, "spec.sessionAffinity.affinityType");
  const policy = text(config, "spec.securityPolicy.name");
  const sample = number(config, "spec.logging.sampleRate");
  const headers = customHeaders(config);
  const parts = [
    healthCheckOf(config),
    timeout === null ? null : `${timeout}s timeout`,
    draining === null ? null : `${draining}s draining`,
    options.cdn === false ? null : cdnSummary(config),
    flag(config, "spec.iap.enabled") ? "IAP on" : null,
    policy === null ? null : `Cloud Armor ${policy}`,
    affinity === null ? null : `${affinity} affinity`,
    // The rate matters as much as the switch: logging at 1% and at 100% are
    // different products when somebody is looking for one request.
    flag(config, "spec.logging.enable")
      ? sample === null || sample === 1
        ? "access logs on"
        : `access logs at ${Math.round(sample * 100)}%`
      : null,
    headers.request.length === 0
      ? null
      : `${headers.request.length} request header${headers.request.length === 1 ? "" : "s"}`,
    headers.response.length === 0
      ? null
      : `${headers.response.length} response header${headers.response.length === 1 ? "" : "s"}`,
  ].filter(Boolean);
  // A BackendConfig that sets nothing is a real object and a real answer:
  // it exists, it is attached, and it changes nothing about the backend.
  return parts.length > 0 ? parts.join(" · ") : "sets nothing";
}

export function frontendConfigSummary(config: CustomResourceInfo): string {
  const policy = text(config, "spec.sslPolicy");
  const code = text(config, "spec.redirectToHttps.responseCodeName");
  const parts = [
    flag(config, "spec.redirectToHttps.enabled")
      ? ["redirects HTTP to HTTPS", code].filter(Boolean).join(" · ")
      : null,
    policy === null ? null : `SSL policy ${policy}`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "sets nothing";
}

// --- managed certificates ------------------------------------------------

/**
 * The controller's own words for where a certificate got to.
 *
 * Taken from `gke-managed-certs`' translation table rather than from the
 * Compute API's, which spells the same states in upper snake case — the
 * object in the cluster carries these.
 */
export type CertificateTone = "ok" | "warn" | "err" | "unknown";

/**
 * How much of a problem one of those words is.
 *
 * `Active` serves. `Provisioning` does not serve *yet*, which is a wait and
 * not a fault — a certificate minutes old is in it by definition. Every
 * `Failed` is a stop: `FailedNotVisible` in particular means Google could
 * not reach the domain, which is almost always DNS that does not point at
 * the Ingress yet, and it will sit there forever without a change.
 *
 * An empty or missing status is **unknown**, and every caller must draw it
 * as such rather than as either of the other two. The controller writes ""
 * for a certificate it has not looked at yet, and a cluster whose
 * controller is not running writes nothing at all — those look identical
 * from here and neither is a verdict.
 */
export function certificateTone(status: string | null): CertificateTone {
  if (status === null || status === "") return "unknown";
  if (status === "Active") return "ok";
  if (status === "Provisioning") return "warn";
  if (status.includes("Failed")) return "err";
  return "unknown";
}

export interface DomainStatus {
  domain: string;
  status: string;
}

export function domainStatuses(
  certificate: CustomResourceInfo
): DomainStatus[] {
  const value = getValueByPath(certificate, "status.domainStatus");
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { domain, status } = entry as { domain?: unknown; status?: unknown };
    if (typeof domain !== "string" || typeof status !== "string") return [];
    return [{ domain, status }];
  });
}

export function certificateStatusOf(
  certificate: CustomResourceInfo
): string | null {
  return text(certificate, "status.certificateStatus");
}

/** The domains the reader asked for, which is the spec and not the status. */
export function certificateDomains(certificate: CustomResourceInfo): string[] {
  const value = getValueByPath(certificate, "spec.domains");
  return Array.isArray(value) ? value.filter((d) => typeof d === "string") : [];
}

/**
 * The domains that are the reason a certificate is not Active, named.
 *
 * A certificate stuck on one of four domains is the case worth the words:
 * the object's own top-level status says only "Provisioning", and the
 * sentence that identifies the DNS record nobody updated is one level down.
 */
export function failingDomains(
  certificate: CustomResourceInfo
): DomainStatus[] {
  return domainStatuses(certificate).filter(
    (entry) => certificateTone(entry.status) === "err"
  );
}
