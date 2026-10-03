import { createFileRoute } from "@tanstack/react-router";
import { EndpointsDetail } from "@/pages/EndpointsDetail";

export const Route = createFileRoute(
  "/c/$cluster/(network)/endpoints/$namespace/$name"
)({
  component: EndpointsDetail,
});
