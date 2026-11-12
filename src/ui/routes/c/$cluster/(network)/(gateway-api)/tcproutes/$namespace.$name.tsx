import { createFileRoute } from "@tanstack/react-router";
import { prefetchObject } from "../../../-object/prefetch";
import { GatewayRouteDetail } from "../-components/GatewayRouteDetail";
import { ResourceType } from "@/lib/resource-registry";

export const Route = createFileRoute(
  "/c/$cluster/(network)/(gateway-api)/tcproutes/$namespace/$name"
)({
  loader: ({ context, params }) =>
    void prefetchObject(context.queryClient, params, "tcproutes"),
  component: () => <GatewayRouteDetail kind={ResourceType.TCPRoute} />,
});
