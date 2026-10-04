import { createFileRoute } from "@tanstack/react-router";
import { prefetchObject } from "../../-object/prefetch";
import { PersistentVolumeDetail } from "@/pages/PersistentVolumeDetail";

export const Route = createFileRoute(
  "/c/$cluster/(storage)/persistentvolumes/$name"
)({
  loader: ({ context, params }) =>
    void prefetchObject(context.queryClient, params, "persistentvolumes"),
  component: PersistentVolumeDetail,
});
