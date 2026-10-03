import { createFileRoute } from "@tanstack/react-router";
import { StatefulSetDetail } from "@/pages/StatefulSetDetail";

export const Route = createFileRoute(
  "/c/$cluster/(workloads)/statefulsets/$namespace/$name"
)({
  component: StatefulSetDetail,
});
