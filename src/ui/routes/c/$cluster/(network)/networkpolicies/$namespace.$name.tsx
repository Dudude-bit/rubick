import { createFileRoute } from "@tanstack/react-router";
import { prefetchObject } from "../../-object/prefetch";
import { NetworkPolicyDetail } from "./-components/NetworkPolicyDetail";

export const Route = createFileRoute(
  "/c/$cluster/(network)/networkpolicies/$namespace/$name"
)({
  loader: ({ context, params }) =>
    void prefetchObject(context.queryClient, params, "networkpolicies"),
  component: NetworkPolicyDetail,
});
