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
import { expiryOf, issuedBy, uncoveredHosts } from "@/lib/certificates";
import { TONE_CLASS } from "./key-values";
import { KeyValueList } from "./detail-kv";
import type { CertificateFacts, TlsCertificate } from "@/generated/types";

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
  if (!read) {
    return (
      <span className="text-[11px] text-fg-fnt">reading the certificate…</span>
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
        {expiry.text}
      </span>
      <span className="text-[11px] text-fg-fnt">{issuedBy(cert)}</span>
      {uncovered.length > 0 && (
        <span className="text-[11px] text-err">
          does not cover {uncovered.join(", ")}
        </span>
      )}
    </span>
  );
}

function chainNote(cert: CertificateFacts): string | null {
  if (cert.chainLength <= 1) return null;
  const rest = cert.chainLength - 1;
  return `with ${rest} more certificate${rest === 1 ? "" : "s"} in the bundle`;
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
  if (!read) return null;

  if (!read.certificate) {
    return (
      <Section>
        <SectionHeader title="Certificate" />
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
      <SectionHeader title="Certificate" count={chainNote(cert) ?? undefined} />
      <KeyValueList
        className="max-w-lg"
        items={[
          {
            label: "Covers",
            value:
              cert.dnsNames.length > 0
                ? cert.dnsNames.join(", ")
                : (cert.subject ?? "no names — it serves nothing"),
            mono: cert.dnsNames.length > 0,
            tone: cert.dnsNames.length > 0 ? undefined : ("warn" as const),
          },
          ...(uncovered.length > 0
            ? [
                {
                  label: "Not covered",
                  value: `${uncovered.join(", ")} — browsers refuse a name the certificate does not carry`,
                  tone: "err" as const,
                },
              ]
            : []),
          {
            label: "Serving now",
            value: expiry.text,
            tone: expiry.tone ?? undefined,
          },
          { label: "Valid", value: dates },
          { label: "Issued by", value: issuedBy(cert) },
          { label: "Serial", value: cert.serial, mono: true },
        ]}
      />
    </Section>
  );
}
