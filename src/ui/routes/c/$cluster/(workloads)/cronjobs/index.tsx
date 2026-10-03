import { createFileRoute } from "@tanstack/react-router";
import { CronJobList } from "@/components/resources/CronJobList";

export const Route = createFileRoute("/c/$cluster/(workloads)/cronjobs/")({
  component: CronJobList,
});
