import { createFileRoute } from "@tanstack/react-router";
import { ConfigMapDetail } from "@/pages/ConfigMapDetail";

export const Route = createFileRoute(
  "/c/$cluster/(config)/configmaps/$namespace/$name"
)({
  component: ConfigMapDetail,
});
