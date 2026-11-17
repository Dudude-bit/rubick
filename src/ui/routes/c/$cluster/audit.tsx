import { createFileRoute } from "@tanstack/react-router";
import { Audit } from "./-audit/Audit";

export const Route = createFileRoute("/c/$cluster/audit")({
  component: Audit,
});
