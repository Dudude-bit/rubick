import { createFileRoute } from "@tanstack/react-router";
import { prefetchObject } from "../../../-object/prefetch";
import { GatewayDetail } from "@/pages/GatewayDetail";

export const Route = createFileRoute(
  "/c/$cluster/(network)/(gateway-api)/gateways/$namespace/$name"
)({
  loader: ({ context, params }) =>
    void prefetchObject(context.queryClient, params, "gateways"),
  component: GatewayDetail,
});
