import { defineVendor } from "../registry";

/**
 * AWS — EKS.
 *
 * Tier one only. The cloud API half of EKS is the one that would also need
 * plumbing that does not exist yet: unlike GCP and Azure, the app holds no
 * AWS profile, because an EKS kubeconfig is obtained by the `aws` CLI
 * rather than by this app.
 */
export default defineVendor({
  id: "aws",
  name: "AWS",
  nodeLabels: {
    pool: ["eks.amazonaws.com/nodegroup"],
    spot: [["eks.amazonaws.com/capacityType", "spot"]],
    providerScheme: ["aws", "AWS"],
  },
});
