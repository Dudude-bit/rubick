import { createFileRoute } from "@tanstack/react-router";
import { NodeDetail } from "@/pages/NodeDetail";

export const Route = createFileRoute("/c/$cluster/(cluster)/nodes/$name")({
  component: NodeDetail,
});
