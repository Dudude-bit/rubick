import { defineVendor } from "../registry";

/**
 * Karpenter.
 *
 * Not a cloud and not a distribution: an autoscaler that makes nodes
 * itself, most often on EKS. It is listed after AWS and before Azure so
 * that a Karpenter node on an EKS cluster is reported under the pool
 * Karpenter named — it is not in a managed node group, so it carries no
 * `eks.amazonaws.com/nodegroup` label to lose.
 *
 * A Karpenter pool is also the one that genuinely mixes spot and on-demand
 * nodes, which is why nothing in the app ever calls a pool "spot" on the
 * strength of one node.
 */
export default defineVendor({
  id: "karpenter",
  name: "Karpenter",
  nodeLabels: {
    pool: [
      "karpenter.sh/nodepool",
      // The pre-v1beta1 spelling, still worn by a cluster on v1alpha5.
      "karpenter.sh/provisioner-name",
    ],
    spot: [["karpenter.sh/capacity-type", "spot"]],
  },
});
