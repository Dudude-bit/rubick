import { createFileRoute } from "@tanstack/react-router";
import { PersistentVolumeDetail } from "@/pages/PersistentVolumeDetail";

export const Route = createFileRoute(
  "/c/$cluster/(storage)/persistentvolumes/$name"
)({
  component: PersistentVolumeDetail,
});
