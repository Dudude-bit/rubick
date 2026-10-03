import { createFileRoute } from "@tanstack/react-router";
import { SecretDetail } from "@/pages/SecretDetail";

export const Route = createFileRoute(
  "/c/$cluster/(config)/secrets/$namespace/$name"
)({
  component: SecretDetail,
});
