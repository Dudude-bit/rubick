import { GitBranch } from "lucide-react";

import { crdObjectPath } from "../kit";
import { defineVendor } from "../registry";
import { crd } from "./crd";
import { facts } from "./facts";

const HELM_RELEASES_CRD = "helmreleases.helm.toolkit.fluxcd.io";

/**
 * Flux CD.
 *
 * Tier two. `delivery.source` — who deployed this object, from which commit,
 * and whether it has drifted — is the capability this vendor is eventually
 * for, and it would be a second field here rather than a second folder
 * anywhere else.
 */
export default defineVendor({
  id: "flux",
  name: "Flux",
  extension: {
    gives:
      "Flux's own objects read as delivery, and the route from a Helm release to the object that reconciles it",
    icon: GitBranch,
    facts,
  },
  crd,
});

/**
 * Where a Flux-managed release's real object is.
 *
 * The one facet that names its vendor out loud, because the surface that
 * uses it already does: the Helm page says "Managed by Flux" before it
 * offers the link. Naming a vendor in *copy* was never the problem; naming
 * one in an `import` is.
 */
export const helmReleasePath = (namespace: string, name: string) =>
  crdObjectPath(HELM_RELEASES_CRD, namespace, name);
