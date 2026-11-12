import { createFileRoute } from "@tanstack/react-router";
import { ConfigMapList } from "./-components/ConfigMapList";

export const Route = createFileRoute("/c/$cluster/(config)/configmaps/")({
  component: ConfigMapList,
});
