import { createFileRoute } from "@tanstack/react-router";
import { prefetchObject } from "../../-object/prefetch";
import { StatefulSetDetail } from "@/pages/StatefulSetDetail";

export const Route = createFileRoute(
  "/c/$cluster/(workloads)/statefulsets/$namespace/$name"
)({
  loader: ({ context, params }) =>
    void prefetchObject(context.queryClient, params, "statefulsets"),
  component: StatefulSetDetail,
});
