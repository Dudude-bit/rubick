import { Layers } from "lucide-react";

import { crdObjectPath } from "../kit";
import { defineVendor } from "../registry";
import { crd } from "./crd";
import { countReconcilers, HELM_RELEASES_CRD } from "./data";
import { facts } from "./facts";

/**
 * Flux CD.
 *
 * Tier two, with nothing behind a credential at all: every fact its page draws
 * is in its CRDs' own `status.conditions`, and unlike Argo there is no second
 * half in a vendor API and no vendor UI to link to. That is what makes the
 * page the only place the whole picture exists.
 *
 * It earns one for the reason `registry.ts` states: it owns objects and a
 * topology no core object can host. Flux's topology is specifically *not*
 * Argo's — a source fetches, a reconciler applies, and several appliers share
 * one source — which is why there are two pages and not one "GitOps" page.
 *
 * The reverse direction — the "managed by" line on the object Flux applied —
 * is `owner.ts`, which resolves the claim against the owner's own inventory
 * rather than trusting a label. It is not in `provides` yet because no surface
 * consumes it.
 */
export default defineVendor({
  id: "flux",
  name: "Flux",
  extension: {
    gives:
      "what Flux is applying, what it is applying from, and where a stopped fetch has quietly frozen the cluster",
    icon: Layers,
    facts,
  },
  page: {
    count: countReconcilers,
    load: () => import("./page"),
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

export { ownerOf as fluxOwnerOf } from "./owner";
