import { createFileRoute } from "@tanstack/react-router";
import { Crds } from "./-components/Crds";

export const Route = createFileRoute(
  "/c/$cluster/(cluster)/customresourcedefinitions/"
)({
  component: Crds,
});
