import { createFileRoute } from "@tanstack/react-router";
import { prefetchObject } from "../../../-object/prefetch";
import { GatewayRouteDetail } from "@/pages/GatewayRouteDetail";
import { ResourceType } from "@/lib/resource-registry";

export const Route = createFileRoute(
  "/c/$cluster/(network)/(gateway-api)/udproutes/$namespace/$name"
)({
  loader: ({ context, params }) =>
    void prefetchObject(context.queryClient, params, "udproutes"),
  component: () => <GatewayRouteDetail kind={ResourceType.UDPRoute} />,
});
