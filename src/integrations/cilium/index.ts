import { Network } from "lucide-react";

import { defineVendor } from "../registry";
import { crd } from "./crd";
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
 * No page. What a page would add over the CRD views — which pods a policy
 * actually selects — needs the endpoint list, and that is one object per pod
 * on every node; the row and the columns are what can be said without it.
 */
export default defineVendor({
  id: "cilium",
  name: "Cilium",
  extension: {
    gives: "ciliumGives",
    icon: Network,
    facts,
  },
  crd,
});
