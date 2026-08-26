/**
 * What a TLS Secret's certificate says, wherever TLS is named.
 *
 * Core, and drawn before anything an extension has to say: a certificate
 * carries its own validity, so the reader gets the expiry on a cluster with
 * nothing installed on it. cert-manager explains *why* a certificate looks
 * the way it does; it is not what makes the date knowable.
 *
 * The private key is not part of any of this. It never leaves the backend.
 */

import { Section, SectionHeader } from "@/components/ui/section";
import { cn } from "@/lib/utils";
import {
  expiryOf,
  expiryText,
  issuedBy,
  uncoveredHosts,
} from "@/lib/certificates";
import { TONE_CLASS } from "./key-values";
import { KeyValueList } from "./detail-kv";
import type { CertificateFacts, TlsCertificate } from "@/generated/types";
import { useT } from "@/i18n/useT";

/** The tone classes, with "no mark" as a real option rather than a colour. */
function toneClass(tone: "warn" | "err" | null): string {
  return tone ? TONE_CLASS[tone] : "text-fg-mid";
}

/**
 * The one line a certificate is worth beside a name.
 *
 * `hosts` are the names the surface expects it to serve — an Ingress's, on
 * the Ingress page. A certificate that is perfectly valid for the wrong
 * name is the failure that reads as working on every other screen, so the
 * mismatch outranks the expiry when both are true.
 */
export function CertificateLine({
  read,
  hosts = [],
}: {
  read: TlsCertificate | undefined;
  hosts?: string[];
}) {
  const t = useT();
  if (!read) {
    return (
      <span className="text-[11px] text-fg-fnt">
        {t("empty", "readingCertificate")}
      </span>
    );
  }
  if (!read.certificate) {
    return <span className="text-[11px] text-warn">{read.problem}</span>;
  }

  const cert = read.certificate;
  const expiry = expiryOf(cert);
  const uncovered = uncoveredHosts(cert, hosts);

  return (
    <span className="flex flex-wrap items-baseline gap-x-2">
      <span className={cn("text-xs", toneClass(expiry.tone))}>
        {expiryText(expiry, t)}
      </span>
      <span className="text-[11px] text-fg-fnt">{issuedBy(cert)}</span>
      {uncovered.length > 0 && (
        <span className="text-[11px] text-err">
          {t("empty", "doesNotCover", { names: uncovered.join(", ") })}
        </span>
      )}
    </span>
  );
}

function chainNote(
  cert: CertificateFacts,
  t: ReturnType<typeof useT>
): string | null {
  if (cert.chainLength <= 1) return null;
  return t("count", "moreCertificatesInBundle", { n: cert.chainLength - 1 });
}

/**
 * The certificate block on the page whose subject *is* the certificate.
 *
 * Here the expiry is stated whatever it is — a Secret page that would not
 * say when its certificate runs out is absurd — and only the colour is
 * rationed.
 */
export function CertificateSection({
  read,
  hosts = [],
}: {
  read: TlsCertificate | undefined;
  hosts?: string[];
}) {
  const t = useT();
  if (!read) return null;

  if (!read.certificate) {
    return (
      <Section>
        <SectionHeader title={t("columns", "certificate")} />
        <p className="text-xs text-warn">{read.problem}</p>
      </Section>
    );
  }

  const cert = read.certificate;
  const expiry = expiryOf(cert);
  const uncovered = uncoveredHosts(cert, hosts);
  const dates = `${new Date(cert.notBefore).toLocaleDateString()} — ${new Date(
    cert.notAfter
  ).toLocaleDateString()}`;

  return (
    <Section>
      <SectionHeader
        title={t("columns", "certificate")}
        count={chainNote(cert, t) ?? undefined}
      />
      <KeyValueList
        className="max-w-lg"
        items={[
          {
            label: t("columns", "covers"),
            value:
              cert.dnsNames.length > 0
                ? cert.dnsNames.join(", ")
                : (cert.subject ?? t("empty", "certNoNames")),
            mono: cert.dnsNames.length > 0,
            tone: cert.dnsNames.length > 0 ? undefined : ("warn" as const),
          },
          ...(uncovered.length > 0
            ? [
                {
                  label: t("columns", "notCovered"),
                  value: t("empty", "certNotCoveredNote", {
                    names: uncovered.join(", "),
                  }),
                  tone: "err" as const,
                },
              ]
            : []),
          {
            label: t("columns", "servingNow"),
            value: expiryText(expiry, t),
            tone: expiry.tone ?? undefined,
          },
          { label: t("columns", "valid"), value: dates },
          { label: t("columns", "issuedBy"), value: issuedBy(cert) },
          { label: t("columns", "serial"), value: cert.serial, mono: true },
        ]}
      />
    </Section>
  );
}
