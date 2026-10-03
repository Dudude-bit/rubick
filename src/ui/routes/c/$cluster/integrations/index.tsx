import { createFileRoute } from "@tanstack/react-router";
import { IntegrationsList } from "@/pages/IntegrationsList";

export const Route = createFileRoute("/c/$cluster/integrations/")({
  component: IntegrationsList,
});
