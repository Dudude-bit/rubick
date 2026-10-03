import { createFileRoute } from "@tanstack/react-router";
import { NodeList } from "@/components/resources/NodeList";

export const Route = createFileRoute("/c/$cluster/(cluster)/nodes/")({
  component: NodeList,
});
