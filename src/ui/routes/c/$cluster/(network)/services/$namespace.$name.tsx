import { createFileRoute } from "@tanstack/react-router";
import { prefetchObject } from "../../-object/prefetch";
import { ServiceDetail } from "./-components/ServiceDetail";

export const Route = createFileRoute(
  "/c/$cluster/(network)/services/$namespace/$name"
)({
  loader: ({ context, params }) =>
    void prefetchObject(context.queryClient, params, "services"),
  component: ServiceDetail,
});
