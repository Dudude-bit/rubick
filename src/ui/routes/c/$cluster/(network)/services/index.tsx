import { createFileRoute } from "@tanstack/react-router";
import { ServiceList } from "@/components/resources/ServiceList";

export const Route = createFileRoute("/c/$cluster/(network)/services/")({
  component: ServiceList,
});
