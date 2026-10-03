import { createFileRoute } from "@tanstack/react-router";
import { NetworkPolicyDetail } from "@/pages/NetworkPolicyDetail";

export const Route = createFileRoute(
  "/c/$cluster/(network)/networkpolicies/$namespace/$name"
)({
  component: NetworkPolicyDetail,
});
