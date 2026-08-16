import { Layers } from "lucide-react";

import { crdObjectPath } from "../kit";
import { defineVendor, pageCount } from "../registry";
import { crd } from "./crd";
import {
  countReconcilers,
  fetchPicture,
  FLUX_STALE,
  HELM_RELEASES_CRD,
  PICTURE_KEY,
} from "./data";
import { facts } from "./facts";
import { ownerOf } from "./owner";
import { relatedTo } from "./related";

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
 * The reverse direction — "this object is delivered by Flux" — is `owner.ts`,
 * behind `delivery.source`. It resolves the claim against the reconciler's own
 * `status.inventory`, and it is where the one asymmetry with Argo is stated
 * rather than papered over: Flux publishes no per-object drift, because it
 * corrects silently and never records that anything differed.
 */
export default defineVendor({
  id: "flux",
  name: "Flux",
  provides: {
    "delivery.source": (objects) => ownerOf(objects),
    "object.related": relatedTo,
  },
  extension: {
    gives:
      "what Flux is applying, what it is applying from, and where a stopped fetch has quietly frozen the cluster",
    icon: Layers,
    facts,
  },
  page: {
    count: pageCount({
      queryKey: PICTURE_KEY,
      queryFn: fetchPicture,
      select: countReconcilers,
      staleTime: FLUX_STALE,
    }),
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
