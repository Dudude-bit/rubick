import { sayWords } from "@/i18n/say";
import type { T } from "@/i18n/useT";
import { covers } from "@/lib/certificates";
import type { IngressInfo } from "@/generated/types";
import type { IngressTlsAnswers } from "@/hooks/useIngressTls";

/**
 * The colour of "TLS not checked" wherever an Ingress's TLS is drawn: apart
 * from both "has TLS" and "no TLS", or the words alone carry the difference.
 */
export const TLS_NOT_CHECKED_TONE = "text-fg-mut";

/** What a cloud controller said about an Ingress's hosts. */
export interface VendorTlsAnswer {
  /** The hosts it terminates. */
  hosts: string[];
  by: string;
  /** The hosts whose TLS is not known, `spec.tls` taken into account. */
  unchecked: string[];
  /** Hosts `spec.tls` covers that the controller serves as plain HTTP anyway. */
  plain: string[];
  /** Why, in the controller's words, for the first of them. */
  plainWhy: string | null;
}

const specCovers = (
  ingress: Pick<IngressInfo, "tlsHosts" | "hasCatchAllTls">,
  host: string
) => ingress.hasCatchAllTls || covers(ingress.tlsHosts, host);

export function vendorTlsAnswer(
  ingress: IngressInfo,
  vendorTls: Pick<IngressTlsAnswers, "of" | "isPending" | "error">,
  t: T
): VendorTlsAnswer | null {
  // A question still out, or one that failed, has not said no.
  const unread = vendorTls.isPending || vendorTls.error !== null;
  const hosts: string[] = [];
  const unchecked: string[] = [];
  const plain: string[] = [];
  let plainWhy: string | null = null;
  // Several rules may name one host; it is still one host.
  const seen = new Set<string>();
  for (const rule of ingress.rules) {
    if (!rule.host || seen.has(rule.host)) continue;
    seen.add(rule.host);
    const said = vendorTls.of(ingress, rule.host);
    if (said?.replacesSpec) {
      const spec = specCovers(ingress, rule.host);
      if (said.terminated === null) unchecked.push(rule.host);
      else if (said.terminated && !spec) hosts.push(rule.host);
      else if (!said.terminated && spec) {
        plain.push(rule.host);
        plainWhy ??= sayWords(said.by, t);
      }
      continue;
    }
    if (said?.terminated === true) hosts.push(rule.host);
    else if (specCovers(ingress, rule.host)) continue;
    else if (said?.terminated === null || (!said && unread))
      unchecked.push(rule.host);
  }
  if (hosts.length === 0 && unchecked.length === 0 && plain.length === 0)
    return null;
  const holder = hosts[0] ? vendorTls.of(ingress, hosts[0])?.by : null;
  const by = holder
    ? sayWords(holder, t)
    : t("empty", "theLoadBalancerInFront");
  return { hosts, by, unchecked, plain, plainWhy };
}

/**
 * Whether one host is served over TLS, as every Ingress surface says it:
 * `spec.tls` and what the controllers said, or `null` where it is not known.
 */
export function hostTlsOf(
  ingress: Pick<IngressInfo, "tlsHosts" | "hasCatchAllTls">,
  host: string,
  vendor: VendorTlsAnswer | null
): boolean | null {
  if (vendor?.plain.includes(host)) return false;
  if (vendor?.unchecked.includes(host)) return null;
  return specCovers(ingress, host) || Boolean(vendor?.hosts.includes(host));
}

/** The address to open an Ingress at, or `null` where its scheme is not known. */
export function ingressOpenUrl(
  ingress: IngressInfo,
  vendor: VendorTlsAnswer | null
): string | null {
  const host =
    ingress.rules.find((rule) => rule.host && rule.host !== "*")?.host ||
    ingress.loadBalancerIps[0];

  if (!host) {
    return null;
  }

  const usesTls = hostTlsOf(ingress, host, vendor);
  if (usesTls === null) return null;
  return `${usesTls ? "https" : "http"}://${host}`;
}
