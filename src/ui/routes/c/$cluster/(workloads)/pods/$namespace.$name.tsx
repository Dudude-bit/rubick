import { createFileRoute } from "@tanstack/react-router";
import { PodDetail } from "@/pages/PodDetail";

export const Route = createFileRoute(
  "/c/$cluster/(workloads)/pods/$namespace/$name"
)({
  component: PodDetail,
});
