import { createFileRoute } from "@tanstack/react-router";
import { Traffic } from "./-traffic/Traffic";

export const Route = createFileRoute("/c/$cluster/traffic")({
  component: Traffic,
});
