import { createFileRoute } from "@tanstack/react-router";
import { prefetchObject } from "../../-object/prefetch";
import { EndpointsDetail } from "./-components/EndpointsDetail";

export const Route = createFileRoute(
  "/c/$cluster/(network)/endpoints/$namespace/$name"
)({
  loader: ({ context, params }) =>
    void prefetchObject(context.queryClient, params, "endpoints"),
  component: EndpointsDetail,
});
