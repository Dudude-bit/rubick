import { sayWords } from "@/i18n/say";
import type { T } from "@/i18n/useT";
import { covers } from "@/lib/certificates";
import { hostTls, type TlsUnread } from "@/lib/ingress-tls";
import { errorToShow, isRefusal } from "@/lib/error-utils";
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
  /** Why a host is unchecked: what its controller said, or how asking failed. `null` while the answer is out. */
  uncheckedWhy: string | null;
}

const specCovers = (
  ingress: Pick<IngressInfo, "tlsHosts" | "hasCatchAllTls">,
  host: string
) => ingress.hasCatchAllTls || covers(ingress.tlsHosts, host);

export function vendorTlsAnswer(
  ingress: IngressInfo,
  vendorTls: Pick<IngressTlsAnswers, "of" | "unread"> &
    Partial<Pick<IngressTlsAnswers, "error">>,
  t: T
): VendorTlsAnswer | null {
  const { unread, error } = vendorTls;
  const hosts: string[] = [];
  const unchecked: string[] = [];
  const plain: string[] = [];
  let plainWhy: string | null = null;
  let uncheckedWhy: string | null = null;
  // Several rules may name one host; it is still one host.
  const seen = new Set<string>();
  for (const rule of ingress.rules) {
    if (!rule.host || seen.has(rule.host)) continue;
    seen.add(rule.host);
    const said = vendorTls.of(ingress, rule.host);
    const spec = specCovers(ingress, rule.host);
    const verdict = hostTls(spec, said, unread);
    if (verdict === null) {
      unchecked.push(rule.host);
      if (said?.terminated === null) uncheckedWhy ??= sayWords(said.by, t);
    } else if (verdict && !spec) hosts.push(rule.host);
    else if (!verdict && spec && said) {
      plain.push(rule.host);
      plainWhy ??= sayWords(said.by, t);
    }
  }
  if (hosts.length === 0 && unchecked.length === 0 && plain.length === 0)
    return null;
  const holder = hosts[0] ? vendorTls.of(ingress, hosts[0])?.by : null;
  const by = holder
    ? sayWords(holder, t)
    : t("empty", "theLoadBalancerInFront");
  if (unchecked.length > 0 && error)
    uncheckedWhy ??= t(
      "empty",
      isRefusal(error) ? "unknownRefused" : "unknownFault",
      { message: errorToShow(error) }
    );
  return { hosts, by, unchecked, plain, plainWhy, uncheckedWhy };
}

/**
 * The `spec.tls` names still served over TLS: one that covers a host its
 * controller serves in the clear is not, wildcard or not.
 */
export const namedTlsHosts = (
  tlsHosts: string[],
  vendor: VendorTlsAnswer | null | undefined
): string[] =>
  tlsHosts.filter(
    (name) => !vendor?.plain.some((host) => covers([name], host))
  );

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

/** Whether an Ingress is served over TLS at all; `unknown` where its controllers have not said or could not tell. */
export type IngressTlsVerdict = "yes" | "no" | "unknown";

/**
 * The one verdict an Ingress's page, its peek, its shared file and its list
 * row say. "no TLS" is a claim about the whole way in, and `spec.tls` is
 * only part of it on every managed cloud, and not all of it under Traefik:
 * it cannot say yes for the controller whose answer replaces it.
 */
export function ingressTlsVerdict(
  ingress: Pick<
    IngressInfo,
    "rules" | "tlsHosts" | "hasCatchAllTls" | "tlsConfigs"
  >,
  vendor: VendorTlsAnswer | null,
  unread: TlsUnread
): IngressTlsVerdict {
  const verdicts = ingress.rules.flatMap((rule) =>
    rule.host ? [hostTlsOf(ingress, rule.host, vendor)] : []
  );
  const named =
    ingress.tlsConfigs.length > 0 && (vendor?.plain.length ?? 0) === 0;
  return verdicts.includes(true) || (named && unread !== "replaces")
    ? "yes"
    : verdicts.includes(null) || named
      ? "unknown"
      : "no";
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

/** Which "no" a TLS cell with no host to count says: none asked for, not checked, or named and served plain. */
export type BareTls = "none" | "notChecked" | "plain";

/**
 * The one line an Ingress's TLS cell says, and which "no" it is where it
 * counts no host. The list's cell and its shared file both read it here: the
 * file printed `spec.tls`'s names beside a cell saying TLS was not checked.
 */
export function tlsCellWords(
  ingress: Pick<IngressInfo, "tlsHosts" | "hasCatchAllTls">,
  vendor: VendorTlsAnswer | null | undefined,
  tls: IngressTlsVerdict,
  t: T
): { words: string; bare: BareTls | null } {
  const served = vendor?.hosts.length ?? 0;
  const plain = vendor?.plain.length ?? 0;
  const named = namedTlsHosts(ingress.tlsHosts, vendor).length;
  const catchAll = ingress.hasCatchAllTls && plain === 0;
  if (tls === "unknown" || (named === 0 && !catchAll && served === 0)) {
    const bare =
      tls === "unknown" || (vendor?.unchecked.length ?? 0) > 0
        ? "notChecked"
        : plain > 0
          ? "plain"
          : "none";
    return {
      words: t("empty", bare === "notChecked" ? "tlsNotChecked" : "noTls"),
      bare,
    };
  }
  return {
    words: catchAll
      ? t("empty", "tlsEveryHost")
      : t("count", "hosts", { n: named + served }),
    bare: null,
  };
}
