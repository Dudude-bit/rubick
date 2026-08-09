import { defineVendor } from "../registry";
import { crd } from "./crd";

/**
 * Traefik.
 *
 * Tier two, and only the CRD facet: nothing here asks the cluster anything
 * it is not already asking. No `gives` and so no Settings row, because
 * there is nothing for a reader to decide — the columns appear on a
 * `traefik.io` list page and cannot appear anywhere else.
 */
export default defineVendor({
  id: "traefik",
  name: "Traefik",
  crd,
});
