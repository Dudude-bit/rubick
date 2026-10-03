import { createFileRoute } from "@tanstack/react-router";
import { ServiceDetail } from "@/pages/ServiceDetail";

export const Route = createFileRoute(
  "/c/$cluster/(network)/services/$namespace/$name"
)({
  component: ServiceDetail,
});
