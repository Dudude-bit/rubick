import { createFileRoute, redirect } from "@tanstack/react-router";

import { ResourceType, toPlural } from "@/lib/resource-registry";

export const Route = createFileRoute("/c/$cluster/(workloads)/replicasets/")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/c/$cluster/deployments",
      params,
      search: { listOf: toPlural(ResourceType.ReplicaSet) },
      replace: true,
    });
  },
});
