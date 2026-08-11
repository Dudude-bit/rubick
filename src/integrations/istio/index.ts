import { Waypoints } from "lucide-react";

import { defineVendor, pageCount } from "../registry";
import { ROUTING_STALE } from "../ingress";
import { crd } from "./crd";
import { countHosts, fetchMesh, MESH_KEY } from "./data";
import { facts } from "./facts";

/**
 * Istio.
 *
 * Tier two. It used to be the vendor with a row and no facts, which was the
 * proof that a folder may declare one facet and stop; it now has all three,
 * and the proof moved on to whoever is written next.
 *
 * It earns a page on the same grounds Traefik does, with one more link in
 * the chain: Gateway → VirtualService → DestinationRule → Service → pods is
 * the same fixed order, and the same drawing serves it. What makes the page
 * worth more than the CRD list is that every link is a reference *by string*
 * that nothing validates — a gateway name, a hostname, a subset label — and
 * a broken one has no status, no event and no condition. It is simply never
 * served.
 *
 * The `crd` view stays beside it and is not made redundant: somebody who
 * reached `virtualservices.networking.istio.io` from the CRD list still
 * wants columns rather than raw YAML.
 */
export default defineVendor({
  id: "istio",
  name: "Istio",
  extension: {
    gives:
      "VirtualServices and DestinationRules read as routing rather than as raw custom resources",
    icon: Waypoints,
    facts,
  },
  page: {
    count: pageCount({
      queryKey: MESH_KEY,
      queryFn: fetchMesh,
      select: countHosts,
      staleTime: ROUTING_STALE,
    }),
    load: () => import("./page"),
  },
  crd,
});
