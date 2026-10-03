import { createFileRoute } from "@tanstack/react-router";
import { JobDetail } from "@/pages/JobDetail";

export const Route = createFileRoute(
  "/c/$cluster/(workloads)/jobs/$namespace/$name"
)({
  component: JobDetail,
});
