import { createFileRoute } from "@tanstack/react-router";
import { HelmDetail } from "./-components/HelmDetail";

export const Route = createFileRoute(
  "/c/$cluster/(cluster)/helm/$source/$namespace/$name"
)({
  component: HelmDetail,
});
