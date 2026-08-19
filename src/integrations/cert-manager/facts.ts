/**
 * What cert-manager is doing for this cluster right now.
 *
 * One list, every namespace, and deliberately no `limit`: a count that
 * stops at the first hundred is not a count, and being the real number is
 * the whole of what the line is worth.
 *
 * Expiry is not judged here. {@link managedExpiryOf} already holds the
 * app's thresholds *and* cert-manager's own renewal plan — a certificate
 * whose `renewalTime` is still ahead is not news however short its life —
 * and a second opinion about when a certificate is worth colouring would
 * disagree with the Certificates page about the same certificate.
 */

import { managedExpiryOf } from "@/lib/certificates";
import { commands } from "@/lib/commands";
import type { CustomResourceInfo } from "@/generated/types";

import {
  crdObjectPath,
  crdObjectsPath,
  getValueByPath,
  plural,
  readyStatus,
} from "../kit";
import type { VendorFact } from "../registry";

const CERTIFICATES_CRD = "certificates.cert-manager.io";

function textAt(
  certificate: CustomResourceInfo,
  path: string
): string | undefined {
  const value = getValueByPath(certificate, path);
  return typeof value === "string" ? value : undefined;
}

export async function facts(): Promise<VendorFact[]> {
  const certificates = await commands.listCustomResources(
    CERTIFICATES_CRD,
    null,
    null,
    null
  );

  const ready: CustomResourceInfo[] = [];
  // A certificate that has been issued before and cannot be renewed is a
  // different problem from one that has never been issued at all: the
  // first is still serving traffic and has until `notAfter` to be fixed,
  // the second is a TLS Secret that does not exist.
  const failingRenewal: CustomResourceInfo[] = [];
  const neverIssued: CustomResourceInfo[] = [];

  for (const certificate of certificates) {
    if (readyStatus(certificate) === "True") {
      ready.push(certificate);
    } else if (textAt(certificate, "status.notAfter")) {
      failingRenewal.push(certificate);
    } else {
      neverIssued.push(certificate);
    }
  }

  const expiring = ready
    .map((certificate) => ({
      certificate,
      expiry: managedExpiryOf(
        {
          notAfter: textAt(certificate, "status.notAfter") ?? "",
          notBefore: textAt(certificate, "status.notBefore") ?? "",
        },
        textAt(certificate, "status.renewalTime") ?? null
      ),
    }))
    .filter(({ expiry }) => expiry.tone !== null)
    .sort((a, b) => a.expiry.days - b.expiry.days);

  const lines: VendorFact[] = [
    { text: plural(certificates.length, "certificate") },
  ];

  if (expiring.length > 0) {
    const soonest = expiring[0].expiry;
    const overdue = expiring.filter(({ expiry }) => expiry.renewalOverdue);
    lines.push({
      // "Renewal overdue" is the diagnosis, so it beats reciting the date;
      // the plain expiry sentence survives for the certificate nobody wrote
      // a plan for.
      text:
        expiring.length === 1
          ? soonest.renewalOverdue
            ? "1 renewal overdue"
            : `1 ${soonest.text}`
          : overdue.length === expiring.length
            ? `${expiring.length} renewals overdue`
            : `${expiring.length} expiring soon`,
      tone: expiring.some(({ expiry }) => expiry.tone === "err")
        ? "err"
        : "warn",
    });
  }
  if (failingRenewal.length > 0) {
    lines.push({
      text: `${failingRenewal.length} ${
        failingRenewal.length === 1 ? "renewal" : "renewals"
      } failing`,
      tone: "err",
    });
  }
  if (neverIssued.length > 0) {
    lines.push({
      text: `${plural(neverIssued.length, "certificate")} never issued`,
      tone: "err",
    });
  }

  // Straight to the object when there is one thing wrong, because that is
  // the page the reader was going to open anyway. A list otherwise: the
  // row is a status line and choosing which of four problems to show first
  // is the list page's job, not this one's.
  const problems = [
    ...failingRenewal,
    ...neverIssued,
    ...expiring.map(({ certificate }) => certificate),
  ];
  if (certificates.length > 0) {
    lines.push({
      text: problems.length === 1 ? "Show it" : "Show them",
      to:
        problems.length === 1
          ? crdObjectPath(
              CERTIFICATES_CRD,
              problems[0].namespace,
              problems[0].name
            )
          : crdObjectsPath(CERTIFICATES_CRD),
    });
  }

  return lines;
}
