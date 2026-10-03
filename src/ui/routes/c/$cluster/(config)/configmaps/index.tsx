import { createFileRoute } from "@tanstack/react-router";
import { ConfigMapList } from "@/components/resources/ConfigMapList";

export const Route = createFileRoute("/c/$cluster/(config)/configmaps/")({
  component: ConfigMapList,
});
