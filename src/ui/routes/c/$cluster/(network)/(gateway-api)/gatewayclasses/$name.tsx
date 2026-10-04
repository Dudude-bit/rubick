import { createFileRoute } from "@tanstack/react-router";
import { prefetchObject } from "../../../-object/prefetch";
import { GatewayClassDetail } from "@/pages/GatewayClassDetail";

export const Route = createFileRoute(
  "/c/$cluster/(network)/(gateway-api)/gatewayclasses/$name"
)({
  loader: ({ context, params }) =>
    void prefetchObject(context.queryClient, params, "gatewayclasses"),
  component: GatewayClassDetail,
});
