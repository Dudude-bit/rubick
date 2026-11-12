import { createFileRoute } from "@tanstack/react-router";
import { IngressList } from "./-components/IngressList";

export const Route = createFileRoute("/c/$cluster/(network)/ingresses/")({
  component: IngressList,
});
