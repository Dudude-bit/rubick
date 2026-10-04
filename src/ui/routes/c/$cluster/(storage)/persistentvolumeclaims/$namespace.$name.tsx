import { createFileRoute } from "@tanstack/react-router";
import { prefetchObject } from "../../-object/prefetch";
import { PersistentVolumeClaimDetail } from "@/pages/PersistentVolumeClaimDetail";

export const Route = createFileRoute(
  "/c/$cluster/(storage)/persistentvolumeclaims/$namespace/$name"
)({
  loader: ({ context, params }) =>
    void prefetchObject(context.queryClient, params, "persistentvolumeclaims"),
  component: PersistentVolumeClaimDetail,
});
