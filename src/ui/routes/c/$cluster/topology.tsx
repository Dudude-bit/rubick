import { createFileRoute } from "@tanstack/react-router";
import { Topology } from "./-topology/Topology";

export const Route = createFileRoute("/c/$cluster/topology")({
  component: Topology,
});
