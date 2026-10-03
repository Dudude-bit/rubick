import { createFileRoute } from "@tanstack/react-router";
import { GatewayClassDetail } from "@/pages/GatewayClassDetail";

export const Route = createFileRoute(
  "/c/$cluster/(network)/(gateway-api)/gatewayclasses/$name"
)({
  component: GatewayClassDetail,
});
