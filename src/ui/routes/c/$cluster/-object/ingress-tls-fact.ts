import { useMemo } from "react";

import type { IngressInfo } from "@/generated/types";
import { useIngressTls } from "@/hooks/useIngressTls";
import { useTlsCertificates } from "@/hooks/useTlsCertificates";
import { useT } from "@/i18n/useT";
import { expiryOf, expiryText } from "@/lib/certificates";
import {
  hostTlsOf,
  ingressTlsVerdict,
  namedTlsHosts,
  vendorTlsAnswer,
} from "./vendor-tls";

/** An Ingress's TLS in one line: words, tone, and whether it could tell. */
export interface IngressTlsFact {
  text: string;
  tone: "warn" | "err" | null;
  known: boolean;
  /** The line is only a count of `hosts`, which a surface may spell out. */
  counted: boolean;
  /** Why it could not tell, once that is known; `null` while the answer is out. */
  why: string | null;
}

/**
 * Whether an Ingress is served over TLS and the one line that says so, as
 * the page, its peek and its shared file all say it.
 */
export function useIngressTlsFact(ingress: IngressInfo | undefined) {
  const t = useT();
  const asked = useMemo(
    () =>
      ingress
        ? [
            {
              namespace: ingress.namespace,
              name: ingress.name,
              hosts: ingress.rules.flatMap((rule) =>
                rule.host ? [rule.host] : []
              ),
            },
          ]
        : [],
    [ingress]
  );
  const vendorTls = useIngressTls(asked);
  const vendor = ingress ? vendorTlsAnswer(ingress, vendorTls, t) : null;
  // `null` where nobody could tell, or the controllers have not answered yet.
  const tlsOf = (host: string): boolean | null =>
    ingress ? hostTlsOf(ingress, host, vendor) : false;
  const tlsConfigs = ingress?.tlsConfigs ?? [];
  const tls = ingress
    ? ingressTlsVerdict(ingress, vendor, vendorTls.unread)
    : "no";

  const secretNames = tlsConfigs.flatMap((config) =>
    config.secretName ? [config.secretName] : []
  );
  const certificates = useTlsCertificates(ingress?.namespace, secretNames);

  // The soonest expiry across every certificate this Ingress serves: one
  // Ingress with four hosts has four certificates, and the badge can only
  // carry the one that runs out first.
  const soonest = secretNames
    .map((secret) => certificates?.get(secret)?.certificate)
    .filter((cert) => cert != null)
    .map((cert) => expiryOf(cert))
    // Exact remaining time rather than whole days: several certificates
    // expiring today all tie on `days`, and this picks the one to show.
    .sort((a, b) => a.left - b.left)[0];

  // Served over TLS under a name that points at nothing, "1 host" read as
  // fine beside a red Status and a red certificate step.
  const missing = secretNames.find(
    (secret) => certificates?.get(secret)?.problem?.says === "noSecret"
  );

  // A host the load balancer holds the certificate for is one `spec.tls` omits.
  const hosts = [
    ...namedTlsHosts(ingress?.tlsHosts ?? [], vendor),
    ...(vendor?.hosts ?? []),
  ];

  // Once the certificate has been read, how long it has left is a more useful
  // answer than how many hosts it covers — the host count is a shape, and the
  // expiry is a date somebody has to act on.
  const said: Pick<IngressTlsFact, "text" | "tone"> =
    tls === "no"
      ? {
          text: vendor?.plainWhy ?? t("empty", "noneTrafficUnencrypted"),
          tone: "warn",
        }
      : tls === "unknown"
        ? { text: t("empty", "tlsNotChecked"), tone: null }
        : missing
          ? {
              text: t("empty", "tlsSecretMissingTitle", { name: missing }),
              tone: "err",
            }
          : soonest
            ? { text: expiryText(soonest, t), tone: soonest.tone ?? null }
            : ingress?.hasCatchAllTls
              ? { text: t("empty", "catchAllCertificate"), tone: "warn" }
              : { text: t("count", "hosts", { n: hosts.length }), tone: null };
  const fact: IngressTlsFact = {
    ...said,
    known: tls !== "unknown",
    why: tls === "unknown" ? (vendor?.uncheckedWhy ?? null) : null,
    counted: tls === "yes" && !missing && !soonest && !ingress?.hasCatchAllTls,
  };

  return {
    tls,
    fact,
    hosts,
    vendor,
    tlsOf,
    certificates,
    secretNames,
    soonest,
    missing,
  };
}
