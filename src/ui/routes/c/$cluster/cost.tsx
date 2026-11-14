import { createFileRoute } from "@tanstack/react-router";
import { CostPage } from "./-cost/CostPage";

export const Route = createFileRoute("/c/$cluster/cost")({
  component: CostPage,
});
