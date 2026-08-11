import { Router } from "lucide-react";

import { defineVendor, pageCount } from "../registry";
import { crd } from "./crd";
import {
  countHosts,
  fetchRouteSources,
  ROUTE_SOURCES,
  ROUTE_STALE,
} from "./data";
import { facts } from "./facts";

/**
 * Traefik.
 *
 * Tier two. Nothing here is configured — the CRDs are in the API server or
 * they are not — and nothing is fetched until the reader opens one of the two
 * screens that names it.
 *
 * It earns a page because it owns a topology no core object can host: "what
 * hosts does this cluster serve, and where does each one go" is not a
 * property of a Service or of a Deployment, it is the routing layer's own
 * shape. The `crd` view stays beside it and is not made redundant by it —
 * somebody who reached `ingressroutes.traefik.io` from the CRD list still
 * wants columns rather than raw YAML.
 */
export default defineVendor({
  id: "traefik",
  name: "Traefik",
  extension: {
    gives: "every host this cluster serves, and where each one stops",
    icon: Router,
    facts,
  },
  page: {
    count: pageCount({
      queryKey: ROUTE_SOURCES,
      queryFn: fetchRouteSources,
      select: countHosts,
      staleTime: ROUTE_STALE,
    }),
    load: () => import("./page"),
  },
  crd,
});
