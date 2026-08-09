import { defineVendor } from "../registry";
import { crd } from "./crd";

/** Istio. Tier two, CRD facet only. */
export default defineVendor({
  id: "istio",
  name: "Istio",
  crd,
});
