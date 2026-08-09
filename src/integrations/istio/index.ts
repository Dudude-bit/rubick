import { Waypoints } from "lucide-react";

import { defineVendor } from "../registry";
import { crd } from "./crd";

/**
 * Istio. Tier two, and the vendor with a row and no facts.
 *
 * That combination has to keep working. `facts` is optional per vendor
 * precisely so a folder can declare one facet and stop — the tree is cheap
 * to add to only for as long as a half-written vendor still draws a whole
 * row, saying what it gives and nothing it does not know.
 */
export default defineVendor({
  id: "istio",
  name: "Istio",
  extension: {
    gives:
      "VirtualServices and DestinationRules read as routing rather than as raw custom resources",
    icon: Waypoints,
  },
  crd,
});
