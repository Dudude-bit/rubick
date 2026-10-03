import { createFileRoute } from "@tanstack/react-router";
import { PersistentVolumeClaimDetail } from "@/pages/PersistentVolumeClaimDetail";

export const Route = createFileRoute(
  "/c/$cluster/(storage)/persistentvolumeclaims/$namespace/$name"
)({
  component: PersistentVolumeClaimDetail,
});
