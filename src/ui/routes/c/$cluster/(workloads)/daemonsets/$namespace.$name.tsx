import { createFileRoute } from "@tanstack/react-router";
import { prefetchObject } from "../../-object/prefetch";
import { DaemonSetDetail } from "./-components/DaemonSetDetail";

export const Route = createFileRoute(
  "/c/$cluster/(workloads)/daemonsets/$namespace/$name"
)({
  loader: ({ context, params }) =>
    void prefetchObject(context.queryClient, params, "daemonsets"),
  component: DaemonSetDetail,
});
