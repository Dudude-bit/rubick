import { createFileRoute } from "@tanstack/react-router";
import { prefetchObject } from "../../-object/prefetch";
import { ConfigMapDetail } from "./-components/ConfigMapDetail";

export const Route = createFileRoute(
  "/c/$cluster/(config)/configmaps/$namespace/$name"
)({
  loader: ({ context, params }) =>
    void prefetchObject(context.queryClient, params, "configmaps"),
  component: ConfigMapDetail,
});
