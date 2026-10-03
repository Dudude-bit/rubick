import { createFileRoute } from "@tanstack/react-router";
import { IntegrationPage } from "@/pages/IntegrationPage";

export const Route = createFileRoute("/c/$cluster/integrations/$vendor")({
  component: IntegrationPage,
});
