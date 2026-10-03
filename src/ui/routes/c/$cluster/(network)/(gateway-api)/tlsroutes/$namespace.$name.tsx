import { createFileRoute } from "@tanstack/react-router";
import { GatewayRouteDetail } from "@/pages/GatewayRouteDetail";
import { ResourceType } from "@/lib/resource-registry";

export const Route = createFileRoute(
  "/c/$cluster/(network)/(gateway-api)/tlsroutes/$namespace/$name"
)({
  component: () => <GatewayRouteDetail kind={ResourceType.TLSRoute} />,
});
