import { createFileRoute } from "@tanstack/react-router";
import { DeploymentList } from "@/components/resources/DeploymentList";

export const Route = createFileRoute("/c/$cluster/(workloads)/deployments/")({
  component: DeploymentList,
});
