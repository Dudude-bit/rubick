import { createFileRoute } from "@tanstack/react-router";
import { PersistentVolumeList } from "./-components/PersistentVolumeList";

export const Route = createFileRoute(
  "/c/$cluster/(storage)/persistentvolumes/"
)({
  component: PersistentVolumeList,
});
