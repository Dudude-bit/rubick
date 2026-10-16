import { createFileRoute } from "@tanstack/react-router";
import { Events } from "./-components/Events";

export const Route = createFileRoute("/c/$cluster/events/")({
  component: Events,
});
