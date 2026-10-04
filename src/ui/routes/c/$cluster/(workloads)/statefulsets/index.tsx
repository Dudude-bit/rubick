import { createFileRoute } from "@tanstack/react-router";
import { StatefulSetList } from "./-components/StatefulSetList";

export const Route = createFileRoute("/c/$cluster/(workloads)/statefulsets/")({
  component: StatefulSetList,
});
