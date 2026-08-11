import { GitBranch } from "lucide-react";

import { defineVendor, pageCount } from "../registry";
import { crd } from "./crd";
import { APPLICATIONS_KEY, ARGO_STALE, fetchApplications } from "./data";
import { facts } from "./facts";
import { ownerOf } from "./owner";

/**
 * Argo CD.
 *
 * Tier two, and entirely so: every fact this page draws is in the
 * `Application` CRD's own status. The half that needs a credential — the
 * line-by-line diff between git and live — is deliberately not implemented
 * and is handed to Argo's own UI, where the cluster says where that is.
 *
 * It earns a page for the same reason Traefik does: it owns objects and a
 * topology no core object can host. "Is what is running what git says should
 * be running" is not a property of a Deployment; the Deployment does not know
 * it is managed at all.
 *
 * The reverse direction — "this object is delivered by Argo" — is `owner.ts`,
 * behind `delivery.source`. It resolves the claim against the Application's own
 * `status.resources` rather than trusting the label, which is what lets the
 * consuming surfaces say "labelled and not listed" instead of asserting.
 */
export default defineVendor({
  id: "argocd",
  name: "Argo CD",
  provides: {
    "delivery.source": (objects) => ownerOf(objects),
  },
  extension: {
    gives:
      "every Application with what it is failing to apply, and which objects differ from git",
    icon: GitBranch,
    facts,
  },
  page: {
    count: pageCount({
      queryKey: APPLICATIONS_KEY,
      queryFn: fetchApplications,
      select: (apps) => apps.length,
      staleTime: ARGO_STALE,
    }),
    load: () => import("./page"),
  },
  crd,
});
