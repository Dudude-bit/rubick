import { createFileRoute } from "@tanstack/react-router";
import { Events } from "@/pages/Events";

export const Route = createFileRoute("/c/$cluster/events/")({
  component: Events,
});
