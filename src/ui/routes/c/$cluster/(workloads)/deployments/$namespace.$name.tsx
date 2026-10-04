import { createFileRoute } from "@tanstack/react-router";
import { prefetchObject } from "../../-object/prefetch";
import { DeploymentDetail } from "@/pages/DeploymentDetail";

export const Route = createFileRoute(
  "/c/$cluster/(workloads)/deployments/$namespace/$name"
)({
  loader: ({ context, params }) =>
    void prefetchObject(context.queryClient, params, "deployments"),
  component: DeploymentDetail,
});
