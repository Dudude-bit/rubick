import { createFileRoute } from "@tanstack/react-router";
import { IntegrationsList } from "./-components/IntegrationsList";

export const Route = createFileRoute("/c/$cluster/integrations/")({
  component: IntegrationsList,
});
