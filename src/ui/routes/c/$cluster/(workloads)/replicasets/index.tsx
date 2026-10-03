import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/c/$cluster/(workloads)/replicasets/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/c/$cluster/deployments", params, replace: true });
  },
});
