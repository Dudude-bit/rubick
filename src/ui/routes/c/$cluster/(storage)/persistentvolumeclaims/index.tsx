import { createFileRoute } from "@tanstack/react-router";
import { PersistentVolumeClaimList } from "./-components/PersistentVolumeClaimList";

export const Route = createFileRoute(
  "/c/$cluster/(storage)/persistentvolumeclaims/"
)({
  component: PersistentVolumeClaimList,
});
