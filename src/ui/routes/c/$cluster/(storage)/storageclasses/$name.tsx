import { createFileRoute } from "@tanstack/react-router";
import { StorageClassDetail } from "@/pages/StorageClassDetail";

export const Route = createFileRoute(
  "/c/$cluster/(storage)/storageclasses/$name"
)({
  component: StorageClassDetail,
});
