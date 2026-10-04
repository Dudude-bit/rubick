import { createFileRoute } from "@tanstack/react-router";
import { prefetchObject } from "../../../-object/prefetch";
import { GatewayRouteDetail } from "@/pages/GatewayRouteDetail";
import { ResourceType } from "@/lib/resource-registry";

export const Route = createFileRoute(
  "/c/$cluster/(network)/(gateway-api)/httproutes/$namespace/$name"
)({
  loader: ({ context, params }) =>
    void prefetchObject(context.queryClient, params, "httproutes"),
  component: () => <GatewayRouteDetail kind={ResourceType.HTTPRoute} />,
});
