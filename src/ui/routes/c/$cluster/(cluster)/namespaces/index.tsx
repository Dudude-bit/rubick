import { createFileRoute } from "@tanstack/react-router";
import { NamespaceList } from "@/components/resources/NamespaceList";

export const Route = createFileRoute("/c/$cluster/(cluster)/namespaces/")({
  component: NamespaceList,
});
