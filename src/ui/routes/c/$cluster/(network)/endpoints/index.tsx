import { createFileRoute } from "@tanstack/react-router";
import { EndpointsList } from "./-components/EndpointsList";

export const Route = createFileRoute("/c/$cluster/(network)/endpoints/")({
  component: EndpointsList,
});
