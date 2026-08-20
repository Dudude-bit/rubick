import { ShieldCheck } from "lucide-react";

import { commands } from "@/lib/commands";
import { defineVendor, pageCount } from "../registry";
import { crd } from "./crd";
import {
  CERTIFICATES_KEY,
  CERT_MANAGER_STALE,
  fetchCertificates,
} from "./data";
import { facts } from "./facts";
import { worstCertificateTone } from "./model";
import { relatedTo } from "./related";

/**
 * cert-manager.
 *
 * Tier two: detected, never configured. Its CRDs exist in the API server or
 * they do not, and that is a fact with a yes or a no — no address, no
 * credential, nothing to fill in and nothing guessed. So there is no config
 * form here and no Connect button anywhere.
 *
 * Note what it does *not* provide: the expiry date. `tls.crt` states that
 * itself, the app reads it on any cluster, and putting it behind this would
 * gate the free half of the value on an install.
 *
 * Two of the facets answer to different rules. `provides` is gated on the
 * backend's CRD scan, because a capability that answered on a cluster
 * without cert-manager would fail at runtime on every request. `crd` is
 * not: a `cert-manager.io` list page can only be reached when the group
 * exists, so the group *is* the detection.
 *
 * It earns a `page` on the rule `registry.ts` states: it owns objects and a
 * topology no core object can host. `Certificate` → `CertificateRequest` →
 * `Order` → `Challenge` is four kinds deep and the sentence that says what
 * failed is on the last of them; that walk is not a property of a Secret or
 * of an Ingress, and there is nowhere else in the app it could hang. The
 * expiry stays off it and on the objects it is about, exactly as before —
 * the page is about *why*, which is the half only cert-manager knows.
 */
export default defineVendor({
  id: "cert-manager",
  name: "cert-manager",
  extension: {
    gives: "why a certificate has not renewed, from the object that failed",
    icon: ShieldCheck,
    facts,
  },
  provides: {
    "certificate.issuance": ({ namespace, secretName }) =>
      commands.getCertificateIssuance(namespace, secretName),
    "object.related": relatedTo,
  },
  page: {
    // The certificates list only, not the whole picture — see `data.ts` for
    // why the walk that explains a failure is a separate query the sidebar
    // never has to pay for.
    count: pageCount({
      queryKey: CERTIFICATES_KEY,
      queryFn: fetchCertificates,
      select: (certificates) => certificates.length,
      tone: worstCertificateTone,
      staleTime: CERT_MANAGER_STALE,
    }),
    load: () => import("./page"),
  },
  crd,
});
