import type { IngressRule } from "@/generated/types";
import { covers } from "@/lib/certificates";

export interface AccessUrl {
  fullUrl: string;
  host: string;
  displayHost: string;
  path: string;
  backendService: string;
  backendPort: string;
  resourceBackend: string | null;
  /** `null` where the controller holding the certificate could not tell. */
  isHttps: boolean | null;
  /** `true` when TLS covers the host only through a catch-all entry. */
  viaCatchAll: boolean;
}

export function generateAccessUrls(
  rules: IngressRule[],
  tlsHosts: string[],
  /** What a wildcard rule reads as in the host column. */
  allHosts: string,
  /**
   * Whether a host is served over TLS, `spec.tls` and the controllers both
   * read: all three managed clouds keep the certificate off the Ingress, and
   * Traefik serves a host `spec.tls` names as plain HTTP unless asked.
   * `null` where it could not be told.
   */
  tlsOf: (host: string) => boolean | null
): AccessUrl[] {
  const urls: AccessUrl[] = [];

  for (const rule of rules) {
    const isWildcard = rule.host === "*" || !rule.host;
    const isHttps = tlsOf(rule.host);
    const scheme = isHttps === null ? "" : isHttps ? "https://" : "http://";
    const actualHost = isWildcard ? "" : rule.host;

    for (const path of rule.paths) {
      urls.push({
        fullUrl: actualHost
          ? `${scheme}${actualHost}${path.path}`
          : `${scheme}<host>${path.path}`,
        host: rule.host,
        displayHost: isWildcard ? allHosts : rule.host,
        path: path.path,
        backendService: path.backendService,
        backendPort: path.backendPort,
        resourceBackend: path.resourceBackend,
        isHttps,
        viaCatchAll: isHttps === true && !covers(tlsHosts, rule.host),
      });
    }
  }

  return urls;
}
