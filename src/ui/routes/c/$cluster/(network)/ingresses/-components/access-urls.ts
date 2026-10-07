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
  hasCatchAllTls: boolean,
  /** What a wildcard rule reads as in the host column. */
  allHosts: string,
  /**
   * What a cloud controller says about a host `spec.tls` is silent on. All
   * three managed clouds keep the certificate off the Ingress — an ACM ARN,
   * a `ManagedCertificate`, one installed on an Application Gateway — so
   * without this every HTTPS site on a managed cluster was offered as
   * `http://`. `null` where it could not tell.
   */
  vendorTls: (host: string) => boolean | null
): AccessUrl[] {
  const urls: AccessUrl[] = [];

  for (const rule of rules) {
    const isWildcard = rule.host === "*" || !rule.host;
    // A wildcard entry in `spec.tls` serves this host; comparing literally
    // handed the reader an http:// URL for a host that refuses it.
    const explicit = covers(tlsHosts, rule.host);
    const isHttps = explicit || hasCatchAllTls || vendorTls(rule.host);
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
        viaCatchAll: isHttps === true && !explicit,
      });
    }
  }

  return urls;
}
