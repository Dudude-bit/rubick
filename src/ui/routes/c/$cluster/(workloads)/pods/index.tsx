import { createFileRoute } from "@tanstack/react-router";
import { PodList } from "@/components/resources/PodList";

export const Route = createFileRoute("/c/$cluster/(workloads)/pods/")({
  component: PodList,
});
