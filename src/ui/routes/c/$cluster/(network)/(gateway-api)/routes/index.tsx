import { createFileRoute } from "@tanstack/react-router";
import { GatewayRoutesList } from "./-components/GatewayRoutesList";

export const Route = createFileRoute(
  "/c/$cluster/(network)/(gateway-api)/routes/"
)({
  component: GatewayRoutesList,
});
