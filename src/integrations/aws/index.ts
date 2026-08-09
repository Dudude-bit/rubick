import { defineVendor } from "../registry";
import { mark } from "./mark";

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
  flavours: [
    {
      id: "eks",
      // An EKS context is the cluster's whole ARN, which also carries a
      // region and an account number — so the ARN is tested before the
      // loose word, and the loose word is what a hand-written entry uses.
      claims: (name, hasWord) => name.startsWith("arn:aws") || hasWord("eks"),
      label: "EKS",
      nameSeparator: "/",
      mark,
    },
  ],
  nodeLabels: {
    pool: ["eks.amazonaws.com/nodegroup"],
    spot: [["eks.amazonaws.com/capacityType", "spot"]],
    providerScheme: ["aws", "AWS"],
  },
});
