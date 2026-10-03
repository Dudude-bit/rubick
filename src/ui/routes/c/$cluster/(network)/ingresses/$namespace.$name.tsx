import { createFileRoute } from "@tanstack/react-router";
import { IngressDetail } from "@/pages/IngressDetail";

export const Route = createFileRoute(
  "/c/$cluster/(network)/ingresses/$namespace/$name"
)({
  component: IngressDetail,
});
