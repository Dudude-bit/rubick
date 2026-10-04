import { createFileRoute } from "@tanstack/react-router";
import { prefetchObject } from "../../-object/prefetch";
import { JobDetail } from "@/pages/JobDetail";

export const Route = createFileRoute(
  "/c/$cluster/(workloads)/jobs/$namespace/$name"
)({
  loader: ({ context, params }) =>
    void prefetchObject(context.queryClient, params, "jobs"),
  component: JobDetail,
});
