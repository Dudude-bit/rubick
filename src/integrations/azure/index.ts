import { KeyRound } from "lucide-react";

import { defineVendor } from "../registry";
import { crd } from "./crd";
import { facts } from "./facts";
import { mark } from "./mark";

/**
 * AKS's add-ons — tier two.
 *
 * Two of them under one row: the Application Gateway ingress controller and
 * aad-pod-identity. They are unrelated products, and they are one row because
 * a reader turns them on in the same place, neither is large enough to be
 * worth its own line in a list somebody scans, and the row is about what this
 * cluster has rather than about Azure's product taxonomy.
 *
 * aad-pod-identity is deprecated in favour of Workload Identity, and is
 * listed anyway because a great many clusters still run it — reading what is
 * actually installed is the entire job of this pane, and skipping the legacy
 * thing would blind it exactly where the cluster is oldest.
 *
 * Separate from the Azure record below, because only a vendor declaring an
 * extension gets a row and a cluster cannot fail to be on Azure. No page: a
 * pod identity belongs on the pod that asks for it.
 */
export const aksAddons = defineVendor({
  id: "aks-addons",
  name: "AKS add-ons",
  extension: {
    gives:
      "which pod identity binds which pods, and what an App Gateway ingress is told to leave alone",
    icon: KeyRound,
    facts,
  },
  crd,
});

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
  flavours: [
    { id: "aks", claims: (_, hasWord) => hasWord("aks"), label: "AKS", mark },
  ],
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
