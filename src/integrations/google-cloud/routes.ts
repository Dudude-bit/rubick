/**
 * What a GKE Ingress actually serves, pivoted by host.
 *
 * This file is the answer to a claim the vendor record used to make — that
 * GKE's objects are "properties of a Service or an Ingress that already has
 * a page" and so own no topology. They are not. Every one of them is joined
 * to the routing table by an *annotation*, and until now the app read
 * exactly one of the four edges:
 *
 * | edge | annotation | before |
 * |---|---|---|
 * | Service → BackendConfig | `cloud.google.com/backend-config` | read |
 * | Ingress → FrontendConfig | `networking.gke.io/v1beta1.FrontendConfig` | — |
 * | Ingress → ManagedCertificate | `networking.gke.io/managed-certificates` | — |
 * | Service → NEG | `cloud.google.com/neg` | — |
 *
 * So a `ManagedCertificate` sitting on `FailedNotVisible` was on its own list
 * page with no way of knowing which hostname it was supposed to serve, and
 * the reader matched domains to Ingress rules by eye. That join is the whole
 * topology: **host → what terminates it → what answers it**, which is the
 * same shape Traefik's and nginx's pages have and is not a property of any
 * one object.
 *
 * ## Which Ingresses are GKE's
 *
 * The annotation, and only the annotation. GKE is explicit that it reads
 * `kubernetes.io/ingress.class` and **ignores `spec.ingressClassName`**, so
 * the `IngressClass`-and-controller reasoning every other routing page uses
 * is wrong here — an Ingress with `ingressClassName: gce` and no annotation
 * is served by nothing at all, which is a finding rather than a row.
 */

import type {
  IngressInfo,
  ServiceInfo,
  ServicePublished,
  CustomResourceInfo,
} from "@/generated/types";
import { covers } from "@/lib/certificates";
import {
  backingOf,
  worstOf,
  type Backing,
  type BackingSources,
} from "../ingress";
import {
  allowsHttp,
  backendConfigRefs,
  certificateTone,
  certificateDomains,
  domainStatuses,
  frontendConfigRef,
  gceClassOf,
  managedCertificateRefs,
  negForIngress,
  preSharedCerts,
  staticIpName,
  type BackendConfigRef,
  type DomainStatus,
} from "./model";

export interface GkeSources extends BackingSources {
  ingresses: IngressInfo[];
  backendConfigs: CustomResourceInfo[];
  frontendConfigs: CustomResourceInfo[];
  managedCertificates: CustomResourceInfo[];
}

/** One path an Ingress serves, and what stands behind it. */
export interface GkeRoute {
  key: string;
  ingress: { name: string; namespace: string };
  host: string | null;
  path: string;
  pathType: string;
  backend: { name: string; port: string } | null;
  /** `backend.resource` — an API object rather than a Service. */
  resourceBackend: string | null;
  /** The configs the backing Service names, and whether each one exists. */
  configs: Array<BackendConfigRef & { found: CustomResourceInfo | undefined }>;
  /** Whether the Service opted into container-native load balancing. */
  neg: boolean;
}

/**
 * The front half of one Ingress: everything that decides how a request is
 * *terminated*, before anything looks at a backend.
 */
export interface GkeFront {
  ingress: { name: string; namespace: string };
  /** `gce`, `gce-internal`, `gce-regional-external`. */
  class: string;
  /** Google's own address, once the controller has assigned one. */
  addresses: string[];
  staticIp: string | null;
  /** `kubernetes.io/ingress.allow-http: "false"` removes the HTTP listener. */
  allowsHttp: boolean;
  frontendConfig: {
    name: string;
    found: CustomResourceInfo | undefined;
  } | null;
  certificates: Array<{
    name: string;
    found: CustomResourceInfo | undefined;
    status: string | null;
    domains: DomainStatus[];
  }>;
  /** Certificates uploaded to Google rather than named in the cluster. */
  preShared: string[];
  /** Secrets named in `spec.tls`, which GKE also accepts. */
  tlsSecrets: string[];
  /**
   * Every hostname this Ingress's own rules name.
   *
   * Kept because a `ManagedCertificate` is only provisioned once Google can
   * reach each of its domains *at this load balancer*: a domain the Ingress
   * does not serve sits on `FailedNotVisible` for ever, and that is not
   * visible from either object alone.
   */
  hosts: string[];
}

export type GkeFinding =
  | { kind: "no-class"; severity: "err"; ingress: string; namespace: string }
  | {
      kind: "missing-object";
      severity: "err";
      what: string;
      name: string;
      why: string;
    }
  | {
      kind: "certificate";
      severity: "err" | "warn";
      certificate: string;
      domain: DomainStatus;
    }
  | {
      kind: "domain-unserved";
      severity: "warn";
      certificate: string;
      domain: string;
    }
  | {
      kind: "wildcard";
      severity: "err";
      certificate: string;
      domain: string;
    }
  | { kind: "no-tls"; severity: "warn"; ingress: string }
  | { kind: "stop"; severity: "err"; route: GkeRoute; backing: Backing };

export interface GkeHost {
  host: string | null;
  routes: GkeRoute[];
  fronts: GkeFront[];
  findings: GkeFinding[];
  worst: "err" | "warn" | null;
}

const byName = (list: CustomResourceInfo[], name: string) =>
  list.find((entry: CustomResourceInfo) => entry.name === name);

const inNamespace = (list: CustomResourceInfo[], namespace: string) =>
  list.filter((entry) => entry.namespace === namespace);

/** Every Ingress this cluster's GKE controller claims. */
export function claimed(ingresses: IngressInfo[]): IngressInfo[] {
  return ingresses.filter(
    (ingress) => gceClassOf(ingress.annotations) !== null
  );
}

/**
 * Ingresses that ask for GKE the way Kubernetes documents and GKE does not
 * read — `spec.ingressClassName` with no annotation beside it.
 *
 * Worth its own list because the object is correct YAML with no events and
 * no error on it, and is simply never served. It is the same shape of
 * silence as an Ingress naming a class nothing claims, one level further in.
 */
export function ignoredByClassName(ingresses: IngressInfo[]): IngressInfo[] {
  return ingresses.filter(
    (ingress) =>
      gceClassOf(ingress.annotations) === null &&
      ingress.className !== null &&
      GCE_CLASS_NAMES.has(ingress.className)
  );
}

const GCE_CLASS_NAMES = new Set([
  "gce",
  "gce-internal",
  "gce-regional-external",
]);

function frontOf(ingress: IngressInfo, sources: GkeSources): GkeFront {
  const namespace = ingress.namespace;
  const frontendName = frontendConfigRef(ingress.annotations);
  return {
    ingress: { name: ingress.name, namespace },
    class: gceClassOf(ingress.annotations) ?? "gce",
    addresses: ingress.loadBalancerIps,
    staticIp: staticIpName(ingress.annotations),
    allowsHttp: allowsHttp(ingress.annotations),
    frontendConfig: frontendName
      ? {
          name: frontendName,
          found: byName(
            inNamespace(sources.frontendConfigs, namespace),
            frontendName
          ),
        }
      : null,
    certificates: managedCertificateRefs(ingress.annotations).map((name) => {
      const found = byName(
        inNamespace(sources.managedCertificates, namespace),
        name
      );
      return {
        name,
        found,
        status: found ? statusOf(found) : null,
        domains: found ? domainStatuses(found) : [],
      };
    }),
    preShared: preSharedCerts(ingress.annotations),
    tlsSecrets: ingress.tlsConfigs.flatMap((config) =>
      config.secretName ? [config.secretName] : []
    ),
    hosts: ingress.rules.flatMap((rule) => (rule.host ? [rule.host] : [])),
  };
}

const statusOf = (certificate: CustomResourceInfo): string | null => {
  const value = certificate.status as { certificateStatus?: unknown } | null;
  return typeof value?.certificateStatus === "string" &&
    value.certificateStatus !== ""
    ? value.certificateStatus
    : null;
};

function routesOf(ingress: IngressInfo, sources: GkeSources): GkeRoute[] {
  const namespace = ingress.namespace;
  const configs = inNamespace(sources.backendConfigs, namespace);
  const services = new Map(
    sources.services
      .filter((service) => service.namespace === namespace)
      .map((service) => [service.name, service] as const)
  );

  return ingress.rules.flatMap((rule, ruleIndex) =>
    rule.paths.map((path, pathIndex): GkeRoute => {
      const service = path.backendService
        ? services.get(path.backendService)
        : undefined;
      const refs = service ? backendConfigRefs(service.annotations) : [];
      return {
        key: `${namespace}/${ingress.name}/${ruleIndex}/${pathIndex}`,
        ingress: { name: ingress.name, namespace },
        host: rule.host || null,
        path: path.path || "/",
        pathType: path.pathType,
        backend: path.backendService
          ? { name: path.backendService, port: path.backendPort }
          : null,
        resourceBackend: path.resourceBackend,
        configs: refs.map((ref) => ({
          ...ref,
          found: byName(configs, ref.name),
        })),
        neg: service ? negForIngress(service.annotations) : false,
      };
    })
  );
}

/**
 * Everything wrong with one host, in the order a reader would act on it.
 *
 * Every finding here is a *missing object* or a status a controller wrote.
 * Nothing is inferred from a silence: `BackendConfig` and `FrontendConfig`
 * carry no status at all, so this file can never say one of them is failing
 * — only that the thing naming it points at nothing.
 */
function findingsFor(
  routes: GkeRoute[],
  fronts: GkeFront[],
  sources: GkeSources
): GkeFinding[] {
  const findings: GkeFinding[] = [];

  for (const front of fronts) {
    if (front.frontendConfig && !front.frontendConfig.found) {
      findings.push({
        kind: "missing-object",
        severity: "err",
        what: "FrontendConfig",
        name: front.frontendConfig.name,
        why: `${front.ingress.name} names it and there is none in ${front.ingress.namespace} — no redirect and no SSL policy are applied`,
      });
    }
    for (const certificate of front.certificates) {
      if (!certificate.found) {
        findings.push({
          kind: "missing-object",
          severity: "err",
          what: "ManagedCertificate",
          name: certificate.name,
          why: `${front.ingress.name} names it and there is none in ${front.ingress.namespace} — nothing terminates TLS for it`,
        });
        continue;
      }
      for (const domain of certificate.domains) {
        const tone = certificateTone(domain.status);
        if (tone === "err" || tone === "warn") {
          findings.push({
            kind: "certificate",
            severity: tone,
            certificate: certificate.name,
            domain,
          });
        }
      }
      for (const domain of certificateDomains(certificate.found)) {
        // Google-managed certificates do not do wildcards at all — up to a
        // hundred names and every one of them literal. A `*.example.com`
        // here is accepted by the API server, never issued by Google, and
        // reported by the object as ordinary provisioning.
        if (domain.startsWith("*.")) {
          findings.push({
            kind: "wildcard",
            severity: "err",
            certificate: certificate.name,
            domain,
          });
          continue;
        }
        // A domain the Ingress does not serve can never provision either:
        // Google checks it by reaching this load balancer at that name, and
        // nothing here answers to it. Matched with `covers` so the reverse
        // case — a host served under a name this certificate spells with a
        // wildcard — is not reported as unserved.
        if (front.hosts.some((host) => covers([domain], host))) continue;
        findings.push({
          kind: "domain-unserved",
          severity: "warn",
          certificate: certificate.name,
          domain,
        });
      }
    }
    // No TLS of any kind and HTTP switched off is an Ingress that answers
    // nothing at all, which is worth saying out loud.
    if (
      !front.allowsHttp &&
      front.certificates.length === 0 &&
      front.preShared.length === 0 &&
      front.tlsSecrets.length === 0
    ) {
      findings.push({
        kind: "no-tls",
        severity: "warn",
        ingress: front.ingress.name,
      });
    }
  }

  const seen = new Set<string>();
  for (const route of routes) {
    for (const config of route.configs) {
      if (config.found || seen.has(`cfg/${config.name}`)) continue;
      seen.add(`cfg/${config.name}`);
      findings.push({
        kind: "missing-object",
        severity: "err",
        what: "BackendConfig",
        name: config.name,
        why: `${route.backend?.name ?? "a Service"} names it and there is none in ${route.ingress.namespace} — the backend keeps its defaults`,
      });
    }
    const backing = backingOf(
      route.backend
        ? { name: route.backend.name, namespace: route.ingress.namespace }
        : null,
      { kind: "Ingress", ...route.ingress },
      sources
    );
    if (backing.stop) {
      const key = `stop/${backing.stop.reason}/${route.backend?.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ kind: "stop", severity: "err", route, backing });
    }
  }

  return findings;
}

/** What one Service publishes, for a row that has already been built. */
export function backingFor(route: GkeRoute, sources: GkeSources): Backing {
  return backingOf(
    route.backend
      ? { name: route.backend.name, namespace: route.ingress.namespace }
      : null,
    { kind: "Ingress", ...route.ingress },
    sources
  );
}

/**
 * The page, pivoted by hostname.
 *
 * Hosts rather than Ingresses, for the reason every routing page in this
 * tree is: two Ingresses serving one hostname is one thing a reader is
 * looking at, and drawing them apart hides exactly the case — a second
 * object quietly claiming a path — that they opened the page to find.
 */
export function hostsOf(sources: GkeSources): GkeHost[] {
  const ours = claimed(sources.ingresses);
  const byHost = new Map<string, { routes: GkeRoute[]; fronts: GkeFront[] }>();

  for (const ingress of ours) {
    const front = frontOf(ingress, sources);
    for (const route of routesOf(ingress, sources)) {
      const key = route.host ?? "";
      const bucket = byHost.get(key) ?? { routes: [], fronts: [] };
      bucket.routes.push(route);
      if (!bucket.fronts.some((seen) => seen.ingress.name === ingress.name)) {
        bucket.fronts.push(front);
      }
      byHost.set(key, bucket);
    }
  }

  const hosts = [...byHost.entries()].map(([key, bucket]): GkeHost => {
    const host = key === "" ? null : key;
    const findings = findingsFor(bucket.routes, bucket.fronts, sources);
    return {
      host,
      routes: bucket.routes,
      fronts: bucket.fronts,
      findings,
      worst: worstOf(findings),
    };
  });

  // Trouble first, then by name; a catch-all has no name and goes last.
  return hosts.sort((left, right) => {
    const rank = (worst: "err" | "warn" | null) =>
      worst === "err" ? 0 : worst === "warn" ? 1 : 2;
    if (rank(left.worst) !== rank(right.worst)) {
      return rank(left.worst) - rank(right.worst);
    }
    if (left.host === null) return 1;
    if (right.host === null) return -1;
    return left.host.localeCompare(right.host);
  });
}

/** The sidebar's number: hosts this GKE Ingress stack serves. */
export function countHosts(ingresses: IngressInfo[]): number {
  const hosts = new Set<string>();
  for (const ingress of claimed(ingresses)) {
    for (const rule of ingress.rules) hosts.add(rule.host || "");
  }
  return hosts.size;
}

export type { ServiceInfo, ServicePublished };
