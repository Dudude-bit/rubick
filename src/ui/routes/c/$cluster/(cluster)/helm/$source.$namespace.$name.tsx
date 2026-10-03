import { createFileRoute } from "@tanstack/react-router";
import { HelmDetail } from "@/pages/HelmDetail";

export const Route = createFileRoute(
  "/c/$cluster/(cluster)/helm/$source/$namespace/$name"
)({
  component: HelmDetail,
});
