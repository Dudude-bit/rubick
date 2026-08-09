import { GitBranch } from "lucide-react";

import { defineVendor } from "../registry";
import { crd } from "./crd";
import { countApplications } from "./data";
import { facts } from "./facts";

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
 * The reverse direction — the "managed by" line on the managed object — is
 * `owner.ts`, which resolves the claim rather than trusting the label. It is
 * not in `provides` yet because no surface consumes it.
 */
export default defineVendor({
  id: "argocd",
  name: "Argo CD",
  extension: {
    gives:
      "every Application with what it is failing to apply, and which objects differ from git",
    icon: GitBranch,
    facts,
  },
  page: {
    count: countApplications,
    load: () => import("./page"),
  },
  crd,
});

export { ownerOf as argoOwnerOf } from "./owner";
