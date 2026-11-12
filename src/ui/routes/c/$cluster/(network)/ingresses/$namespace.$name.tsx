import { createFileRoute } from "@tanstack/react-router";
import { prefetchObject } from "../../-object/prefetch";
import { IngressDetail } from "./-components/IngressDetail";

export const Route = createFileRoute(
  "/c/$cluster/(network)/ingresses/$namespace/$name"
)({
  loader: ({ context, params }) =>
    void prefetchObject(context.queryClient, params, "ingresses"),
  component: IngressDetail,
});
