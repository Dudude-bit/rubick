import { createFileRoute } from "@tanstack/react-router";
import { EndpointsList } from "@/components/resources/EndpointsList";

export const Route = createFileRoute("/c/$cluster/(network)/endpoints/")({
  component: EndpointsList,
});
