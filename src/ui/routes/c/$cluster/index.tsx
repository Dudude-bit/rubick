import { createFileRoute } from "@tanstack/react-router";
import { ClusterOverview } from "./-overview/ClusterOverview";

export const Route = createFileRoute("/c/$cluster/")({
  component: ClusterOverview,
});
