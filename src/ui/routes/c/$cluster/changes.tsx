import { createFileRoute } from "@tanstack/react-router";
import { Changes } from "@/pages/Changes";

export const Route = createFileRoute("/c/$cluster/changes")({
  component: Changes,
});
