import { createFileRoute } from "@tanstack/react-router";
import { CrdDetail } from "@/pages/CrdDetail";

export const Route = createFileRoute(
  "/c/$cluster/(cluster)/customresourcedefinitions/$name"
)({
  component: CrdDetail,
});
