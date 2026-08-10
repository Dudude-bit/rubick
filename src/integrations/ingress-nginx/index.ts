import { Network } from "lucide-react";

import { defineVendor } from "../registry";
import { countHosts } from "./data";
import { facts } from "./facts";

/**
 * ingress-nginx.
 *
 * Tier two, and the first vendor in this tree detected without a CRD — it
 * ships none. What the backend looks at instead is
 * `IngressClass.spec.controller`, which is a declared field saying
 * `k8s.io/ingress-nginx`: the same kind of fact as a marker CRD, and just as
 * far from a heuristic.
 *
 * No `crd` view, for the same reason. There is nothing to give columns to.
 *
 * It earns a page on the same grounds Traefik does — it owns a topology no
 * core object can host — and on one more that is its alone: its behaviour
 * lives in around ninety annotations and one global ConfigMap, and neither
 * is legible anywhere in this app today. An Ingress carrying twelve
 * `nginx.ingress.kubernetes.io/*` keys is a program, and the Ingress page
 * renders it as a blob of strings.
 */
export default defineVendor({
  id: "ingress-nginx",
  name: "ingress-nginx",
  extension: {
    gives: "annotations read as behaviour instead of as a wall of strings",
    icon: Network,
    facts,
  },
  page: {
    count: countHosts,
    load: () => import("./page"),
  },
});
