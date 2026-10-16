import { createFileRoute } from "@tanstack/react-router";
import { prefetchObject } from "../../-object/prefetch";
import { StorageClassDetail } from "./-components/StorageClassDetail";

export const Route = createFileRoute(
  "/c/$cluster/(storage)/storageclasses/$name"
)({
  loader: ({ context, params }) =>
    void prefetchObject(context.queryClient, params, "storageclasses"),
  component: StorageClassDetail,
});
