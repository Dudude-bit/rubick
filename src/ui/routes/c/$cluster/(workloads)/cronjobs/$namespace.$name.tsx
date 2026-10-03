import { createFileRoute } from "@tanstack/react-router";
import { CronJobDetail } from "@/pages/CronJobDetail";

export const Route = createFileRoute(
  "/c/$cluster/(workloads)/cronjobs/$namespace/$name"
)({
  component: CronJobDetail,
});
