import { createFileRoute } from "@tanstack/react-router";
import { NetworkPolicyList } from "./-components/NetworkPolicyList";

export const Route = createFileRoute("/c/$cluster/(network)/networkpolicies/")({
  component: NetworkPolicyList,
});
