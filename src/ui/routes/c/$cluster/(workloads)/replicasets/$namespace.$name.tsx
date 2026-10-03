import { createFileRoute } from "@tanstack/react-router";
import { ReplicaSetDetail } from "@/pages/ReplicaSetDetail";

export const Route = createFileRoute(
  "/c/$cluster/(workloads)/replicasets/$namespace/$name"
)({
  component: ReplicaSetDetail,
});
