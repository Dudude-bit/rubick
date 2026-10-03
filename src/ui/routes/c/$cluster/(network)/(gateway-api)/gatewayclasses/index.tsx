import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute(
  "/c/$cluster/(network)/(gateway-api)/gatewayclasses/"
)({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/c/$cluster/gateways", params, replace: true });
  },
});
