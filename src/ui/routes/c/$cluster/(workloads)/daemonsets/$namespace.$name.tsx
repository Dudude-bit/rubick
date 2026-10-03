import { createFileRoute } from "@tanstack/react-router";
import { DaemonSetDetail } from "@/pages/DaemonSetDetail";

export const Route = createFileRoute(
  "/c/$cluster/(workloads)/daemonsets/$namespace/$name"
)({
  component: DaemonSetDetail,
});
