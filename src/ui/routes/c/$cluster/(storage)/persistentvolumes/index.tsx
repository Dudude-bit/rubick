import { createFileRoute } from "@tanstack/react-router";
import { PersistentVolumeList } from "@/components/resources/PersistentVolumeList";

export const Route = createFileRoute(
  "/c/$cluster/(storage)/persistentvolumes/"
)({
  component: PersistentVolumeList,
});
