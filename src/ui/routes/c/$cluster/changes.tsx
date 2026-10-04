import { createFileRoute } from "@tanstack/react-router";
import { Changes } from "./-changes/Changes";

export const Route = createFileRoute("/c/$cluster/changes")({
  component: Changes,
});
