import { createFileRoute } from "@tanstack/react-router";
import { NamespaceDetail } from "@/pages/NamespaceDetail";

export const Route = createFileRoute("/c/$cluster/(cluster)/namespaces/$name")({
  component: NamespaceDetail,
});
