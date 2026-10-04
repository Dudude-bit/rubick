import { createFileRoute } from "@tanstack/react-router";
import { prefetchObject } from "../../-object/prefetch";
import { SecretDetail } from "@/pages/SecretDetail";

export const Route = createFileRoute(
  "/c/$cluster/(config)/secrets/$namespace/$name"
)({
  loader: ({ context, params }) =>
    void prefetchObject(context.queryClient, params, "secrets"),
  component: SecretDetail,
});
