import { createFileRoute } from "@tanstack/react-router";
import { NetworkPolicyList } from "@/components/resources/NetworkPolicyList";

export const Route = createFileRoute("/c/$cluster/(network)/networkpolicies/")({
  component: NetworkPolicyList,
});
