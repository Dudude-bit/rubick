import { createFileRoute } from "@tanstack/react-router";
import { GatewayList } from "@/components/resources/GatewayList";

export const Route = createFileRoute(
  "/c/$cluster/(network)/(gateway-api)/gateways/"
)({
  component: GatewayList,
});
