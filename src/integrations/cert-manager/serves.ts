/**
 * Which hostnames a Certificate is actually serving, and whether it can.
 *
 * A `Certificate` names a Secret and some DNS names, and stops there. What
 * *uses* that Secret is somewhere else entirely, and on the cluster this was
 * written against it is three hops away: cert-manager writes the Secret, a
 * Google load balancer's Ingress terminates TLS with it, and plaintext goes
 * on to Traefik. The certificate page could say a certificate was `Ready` and
 * had thirty days left; it could not say which address in the world would
 * stop working when it did not renew.
 *
 * The join runs backwards — the Secret is named by the thing that uses it,
 * never the other way round — so this reads the Ingresses and looks for the
 * name. Nothing here needs to know which controller serves them: a
 * `spec.tls` block is core Kubernetes and means the same thing whoever picks
 * it up.
 *
 * **What is deliberately not covered**: a Secret used by a routing CRD — a
 * Traefik `IngressRoute`, an Istio `Gateway`. Those are the vendor's own
 * objects and this file may not import them; a certificate used only by one
 * comes back with no users rather than with a wrong answer, which is why
 * {@link CertificateUse.unusedIsCertain} exists.
 */

import type { IngressInfo } from "@/generated/types";
import { covers } from "@/lib/certificates";

export interface ServedHost {
  host: string;
  ingress: { name: string; namespace: string };
  /**
   * Whether the certificate's own names reach this host.
   *
   * `false` is a browser error on a page every other surface in the app
   * draws as healthy: the Secret is populated, the Ingress is serving, the
   * certificate is `Ready`, and it is for the wrong name.
   */
  covered: boolean;
}

export interface CertificateUse {
  hosts: ServedHost[];
  /**
   * Whether "nothing uses this" may be said out loud.
   *
   * False where the cluster runs something whose routes live in a CRD this
   * file cannot read — the certificate may be serving perfectly through one,
   * and calling it unused would send somebody to delete a working thing.
   */
  unusedIsCertain: boolean;
}

/**
 * The hosts an Ingress serves under a given Secret.
 *
 * A `spec.tls` entry with no hosts is the catch-all — it applies to every
 * rule the Ingress carries — so the hosts come from the rules in that case
 * rather than from the TLS block.
 */
function hostsUnder(ingress: IngressInfo, secretName: string): string[] {
  const ruleHosts = ingress.rules.flatMap((rule) =>
    rule.host ? [rule.host] : []
  );
  const hosts = new Set<string>();
  for (const config of ingress.tlsConfigs) {
    if (config.secretName !== secretName) continue;
    if (config.isCatchAll || config.hosts.length === 0) {
      for (const host of ruleHosts) hosts.add(host);
      continue;
    }
    for (const host of config.hosts) hosts.add(host);
  }
  return [...hosts];
}

export function certificateUse(
  certificate: {
    secretName: string | null;
    namespace: string;
    dnsNames: string[];
  },
  ingresses: IngressInfo[],
  options: { unusedIsCertain: boolean }
): CertificateUse {
  if (certificate.secretName === null) {
    return { hosts: [], unusedIsCertain: options.unusedIsCertain };
  }

  const hosts: ServedHost[] = [];
  for (const ingress of ingresses) {
    // A Secret is namespaced and an Ingress may only mount one from its own
    // namespace, so this is a real constraint rather than a filter.
    if (ingress.namespace !== certificate.namespace) continue;
    for (const host of hostsUnder(ingress, certificate.secretName)) {
      hosts.push({
        host,
        ingress: { name: ingress.name, namespace: ingress.namespace },
        covered: covers(certificate.dnsNames, host),
      });
    }
  }

  return {
    hosts: hosts.sort((left, right) => left.host.localeCompare(right.host)),
    unusedIsCertain: options.unusedIsCertain,
  };
}

/** The hosts this certificate is serving and cannot answer for. */
export function uncovered(use: CertificateUse): ServedHost[] {
  return use.hosts.filter((entry) => !entry.covered);
}
