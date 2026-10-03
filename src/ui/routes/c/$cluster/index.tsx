import { createFileRoute } from "@tanstack/react-router";
import { ClusterOverview } from "@/pages/ClusterOverview";

export const Route = createFileRoute("/c/$cluster/")({
  component: ClusterOverview,
});
