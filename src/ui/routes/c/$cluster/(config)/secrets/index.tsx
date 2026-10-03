import { createFileRoute } from "@tanstack/react-router";
import { SecretList } from "@/components/resources/SecretList";

export const Route = createFileRoute("/c/$cluster/(config)/secrets/")({
  component: SecretList,
});
