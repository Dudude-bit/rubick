import { createFileRoute } from "@tanstack/react-router";
import { DeploymentDetail } from "@/pages/DeploymentDetail";

export const Route = createFileRoute(
  "/c/$cluster/(workloads)/deployments/$namespace/$name"
)({
  component: DeploymentDetail,
});
