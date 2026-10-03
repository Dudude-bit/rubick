import { createFileRoute } from "@tanstack/react-router";
import { Crds } from "@/pages/Crds";

export const Route = createFileRoute(
  "/c/$cluster/(cluster)/customresourcedefinitions/"
)({
  component: Crds,
});
