import { defineVendor } from "../registry";
import { crd } from "./crd";

/**
 * Flux CD.
 *
 * Tier two, CRD facet only for now. `delivery.source` — who deployed this
 * object, from which commit, and whether it has drifted — is the capability
 * this vendor is eventually for, and it would be a second field here rather
 * than a second folder anywhere else.
 */
export default defineVendor({
  id: "flux",
  name: "Flux",
  crd,
});

/**
 * Where a Flux-managed release's real object is.
 *
 * The Helm pages need it because a release Flux owns is not theirs to
 * reconcile, and the two of them had the group and plural spelled out in a
 * template literal each — the smallest possible version of the drift this
 * tree exists to stop.
 */
export const helmReleasePath = (namespace: string, name: string) =>
  `/crds/helm.toolkit.fluxcd.io/helmreleases/${namespace}/${name}`;
