import { defineVendor } from "../registry";

/**
 * Azure — AKS.
 *
 * AKS's deprecated unprefixed `agentpool` is deliberately not listed: every
 * AKS node also carries the prefixed one, so it would add nothing while
 * making any cluster where somebody typed `agentpool` by hand look managed.
 */
export default defineVendor({
  id: "azure",
  name: "Azure",
  nodeLabels: {
    pool: ["kubernetes.azure.com/agentpool"],
    spot: [
      ["kubernetes.azure.com/priority", "spot"],
      // AKS deprecated this one in favour of `priority`; older nodes wear it.
      ["kubernetes.azure.com/scalesetpriority", "spot"],
    ],
    providerScheme: ["azure", "Azure"],
  },
});
