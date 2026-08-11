/**
 * What GKE's Ingress stack is doing for this cluster right now.
 *
 * One inventory line and exactly one problem, and the problem can only ever
 * come from the certificates. `BackendConfig` and `FrontendConfig` report
 * nothing about themselves — no status, no conditions, by design upstream —
 * so a count is the whole truth available about them and this row does not
 * pretend otherwise. Colouring them by reading their spec would be the app
 * inventing a verdict for an object that has never had one.
 *
 * `ManagedCertificate` is where the reader's actual question is. A GKE
 * Ingress that serves nothing over HTTPS for an hour after a clean deploy is
 * almost always a certificate stuck on `FailedNotVisible` for one domain
 * whose DNS was never pointed at the load balancer, and that sentence is two
 * levels inside an object nobody opens.
 */

import { commands } from "@/lib/commands";

import { crdObjectPath, crdObjectsPath, plural } from "../kit";
import type { VendorFact } from "../registry";
import {
  BACKEND_CONFIG_CRD,
  FRONTEND_CONFIG_CRD,
  MANAGED_CERTIFICATE_CRD,
  certificateStatusOf,
  certificateTone,
  failingDomains,
} from "./model";

export async function facts(): Promise<VendorFact[]> {
  const [backendConfigs, frontendConfigs, certificates] = await Promise.all([
    commands.listCustomResources(BACKEND_CONFIG_CRD, null, null, null),
    commands.listCustomResources(FRONTEND_CONFIG_CRD, null, null, null),
    commands.listCustomResources(MANAGED_CERTIFICATE_CRD, null, null, null),
  ]);

  const lines: VendorFact[] = [
    {
      text: [
        plural(backendConfigs.length, "BackendConfig"),
        plural(frontendConfigs.length, "FrontendConfig"),
        plural(certificates.length, "ManagedCertificate"),
      ].join(" · "),
    },
  ];

  // Three buckets and the fourth is deliberately dropped: a certificate whose
  // status is empty or missing is one the controller has not written to, and
  // on a cluster where that controller is not running it is *every*
  // certificate. Counting those as anything would state a verdict the
  // cluster never gave.
  const failed = certificates.filter(
    (certificate) => certificateTone(certificateStatusOf(certificate)) === "err"
  );
  const provisioning = certificates.filter(
    (certificate) =>
      certificateTone(certificateStatusOf(certificate)) === "warn"
  );

  if (failed.length > 0) {
    // The domain, not the count, where there is one to name — "FailedNotVisible
    // on shop.example.com" is a DNS record somebody can go and fix, and
    // "1 certificate failed" is a reason to open four pages.
    const domain = failed.length === 1 ? failingDomains(failed[0])[0] : null;
    lines.push({
      text: domain
        ? `${domain.status} on ${domain.domain}`
        : `${plural(failed.length, "certificate")} failed`,
      tone: "err",
    });
  }
  if (provisioning.length > 0) {
    lines.push({
      // Not an error: a certificate minutes old is in this state by
      // definition, and Google takes up to an hour over one at the best of
      // times. It is worth a colour only because an Ingress serving no HTTPS
      // looks identical to a broken one until you know this is why.
      text: `${provisioning.length} not serving yet`,
      tone: "warn",
    });
  }

  const problems = [...failed, ...provisioning];
  if (certificates.length > 0) {
    lines.push({
      text: problems.length === 1 ? "Show it" : "Show them",
      to:
        problems.length === 1
          ? crdObjectPath(
              MANAGED_CERTIFICATE_CRD,
              problems[0].namespace,
              problems[0].name
            )
          : crdObjectsPath(MANAGED_CERTIFICATE_CRD),
    });
  }

  return lines;
}
