import { createFileRoute } from "@tanstack/react-router";
import { MyAccess } from "./-components/MyAccess";

export const Route = createFileRoute("/c/$cluster/my-access/")({
  component: MyAccess,
});
