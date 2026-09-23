import { Network } from "lucide-react";

import { defineVendor, pageCount } from "../registry";
import { ROUTING_STALE } from "../ingress";
import { crd } from "./crd";
import {
  countUnrestricted,
  coverageTone,
  fetchPicture,
  PICTURE_KEY,
} from "./data";
import { facts } from "./facts";

/**
 * Cilium.
 *
 * The CNI, and the first vendor here that is one. It earns a row for a
 * reason the other network vendors do not have: **a Cilium policy the agent
 * rejected is still an object.** It has a name, an age and a spec, it sits
 * in the list beside the policies that work, and the only place its being
 * thrown away is written down is a condition inside its status — which no
 * vanilla list of custom resources shows. A namespace a reader believes is
 * closed can be one typo away from open, with nothing red anywhere.
 *
 * A `Ready`-shaped reader of these objects would get the other half wrong:
 * Cilium writes the `Valid` condition once it has looked, so a policy it has
 * not answered about carries no condition at all. That is a third state, and
 * it is drawn as one.
 *
 * The page is the join the CRD views cannot do: a policy names labels, a
 * `CiliumEndpoint` carries the labels Cilium resolved for the pod, and only
 * the two together say whether a pod is covered — or is selected solely by
 * policies that were thrown away, which reads as covered from every other
 * screen in this app.
 */
export default defineVendor({
  id: "cilium",
  name: "Cilium",
  extension: {
    gives: "ciliumGives",
    icon: Network,
    facts,
  },
  page: {
    count: pageCount({
      queryKey: PICTURE_KEY,
      queryFn: fetchPicture,
      select: countUnrestricted,
      tone: coverageTone,
      staleTime: ROUTING_STALE,
    }),
    load: () => import("./page"),
    gate: { crd: "ciliumnetworkpolicies.cilium.io", namespaced: true },
  },
  crd,
});
