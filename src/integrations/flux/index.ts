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
