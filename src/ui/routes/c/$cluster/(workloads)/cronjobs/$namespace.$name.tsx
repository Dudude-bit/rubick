import { createFileRoute } from "@tanstack/react-router";
import { prefetchObject } from "../../-object/prefetch";
import { CronJobDetail } from "@/pages/CronJobDetail";

export const Route = createFileRoute(
  "/c/$cluster/(workloads)/cronjobs/$namespace/$name"
)({
  loader: ({ context, params }) =>
    void prefetchObject(context.queryClient, params, "cronjobs"),
  component: CronJobDetail,
});
