import { createFileRoute } from "@tanstack/react-router";
import { DaemonSetList } from "@/components/resources/DaemonSetList";

export const Route = createFileRoute("/c/$cluster/(workloads)/daemonsets/")({
  component: DaemonSetList,
});
