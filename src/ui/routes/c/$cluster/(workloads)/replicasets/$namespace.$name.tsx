import { createFileRoute } from "@tanstack/react-router";
import { prefetchObject } from "../../-object/prefetch";
import { ReplicaSetDetail } from "@/pages/ReplicaSetDetail";

export const Route = createFileRoute(
  "/c/$cluster/(workloads)/replicasets/$namespace/$name"
)({
  loader: ({ context, params }) =>
    void prefetchObject(context.queryClient, params, "replicasets"),
  component: ReplicaSetDetail,
});
