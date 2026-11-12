import { createFileRoute, redirect } from "@tanstack/react-router";

import { ResourceType, toPlural } from "@/lib/resource-registry";

export const Route = createFileRoute(
  "/c/$cluster/(network)/(gateway-api)/gatewayclasses/"
)({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/c/$cluster/gateways",
      params,
      search: { listOf: toPlural(ResourceType.GatewayClass) },
      replace: true,
    });
  },
});
