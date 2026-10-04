import { createFileRoute } from "@tanstack/react-router";
import { prefetchObject } from "../../-object/prefetch";
import { PodDetail } from "@/pages/PodDetail";

export const Route = createFileRoute(
  "/c/$cluster/(workloads)/pods/$namespace/$name"
)({
  loader: ({ context, params }) =>
    void prefetchObject(context.queryClient, params, "pods"),
  component: PodDetail,
});
