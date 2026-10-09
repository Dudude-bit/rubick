import { createFileRoute } from "@tanstack/react-router";
import { ApiResources } from "./-components/ApiResources";

export const Route = createFileRoute("/c/$cluster/api-resources/")({
  component: ApiResources,
});
