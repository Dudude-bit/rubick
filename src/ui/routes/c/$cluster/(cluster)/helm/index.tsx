import { createFileRoute } from "@tanstack/react-router";
import { Helm } from "./-components/Helm";

export const Route = createFileRoute("/c/$cluster/(cluster)/helm/")({
  component: Helm,
});
