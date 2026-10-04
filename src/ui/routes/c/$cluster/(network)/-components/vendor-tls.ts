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
  /** The hosts it could not tell about, or has not answered for yet. */
  unchecked: string[];
}

export function vendorTlsAnswer(
  ingress: IngressInfo,
  vendorTls: Pick<IngressTlsAnswers, "of" | "isPending" | "error">,
  t: T
): VendorTlsAnswer | null {
  // A question still out, or one that failed, has not said no.
  const unread = vendorTls.isPending || vendorTls.error !== null;
  const hosts: string[] = [];
  const unchecked: string[] = [];
  // Several rules may name one host; it is still one host.
  const seen = new Set<string>();
  for (const rule of ingress.rules) {
    if (!rule.host || seen.has(rule.host)) continue;
    seen.add(rule.host);
    const said = vendorTls.of(ingress, rule.host)?.terminated;
    if (said === true) hosts.push(rule.host);
    else if (said === null || (said === undefined && unread))
      unchecked.push(rule.host);
  }
  if (hosts.length === 0 && unchecked.length === 0) return null;
  const holder = hosts[0] ? vendorTls.of(ingress, hosts[0])?.by : null;
  const by = holder
    ? sayWords(holder, t)
    : t("empty", "theLoadBalancerInFront");
  return { hosts, by, unchecked };
}

/** The address to open an Ingress at, or `null` where its scheme is not known. */
export function ingressOpenUrl(
  ingress: IngressInfo,
  /** What a controller says about the hosts `spec.tls` never mentions. */
  vendor: VendorTlsAnswer | null
): string | null {
  const host =
    ingress.rules.find((rule) => rule.host && rule.host !== "*")?.host ||
    ingress.loadBalancerIps[0];

  if (!host) {
    return null;
  }

  // `covers` rather than equality: `*.example.com` is how a wildcard Secret
  // serves `shop.example.com`, and a literal comparison offered http:// for
  // every subdomain behind one.
  const usesTls =
    covers(ingress.tlsHosts, host) ||
    ingress.hasCatchAllTls ||
    Boolean(vendor?.hosts.includes(host));
  if (!usesTls && vendor?.unchecked.includes(host)) return null;
  const scheme = usesTls ? "https" : "http";
  return `${scheme}://${host}`;
}
