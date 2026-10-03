import { createFileRoute } from "@tanstack/react-router";
import { Helm } from "@/pages/Helm";

export const Route = createFileRoute("/c/$cluster/(cluster)/helm/")({
  component: Helm,
});
