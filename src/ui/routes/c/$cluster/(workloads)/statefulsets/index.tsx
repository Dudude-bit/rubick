import { createFileRoute } from "@tanstack/react-router";
import { StatefulSetList } from "@/components/resources/StatefulSetList";

export const Route = createFileRoute("/c/$cluster/(workloads)/statefulsets/")({
  component: StatefulSetList,
});
