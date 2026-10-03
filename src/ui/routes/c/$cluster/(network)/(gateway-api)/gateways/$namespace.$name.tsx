import { createFileRoute } from "@tanstack/react-router";
import { GatewayDetail } from "@/pages/GatewayDetail";

export const Route = createFileRoute(
  "/c/$cluster/(network)/(gateway-api)/gateways/$namespace/$name"
)({
  component: GatewayDetail,
});
