import { createFileRoute } from "@tanstack/react-router";
import { prefetchObject } from "../../-object/prefetch";
import { CrdDetail } from "@/pages/CrdDetail";

export const Route = createFileRoute(
  "/c/$cluster/(cluster)/customresourcedefinitions/$name"
)({
  loader: ({ context, params }) =>
    void prefetchObject(
      context.queryClient,
      params,
      "customresourcedefinitions"
    ),
  component: CrdDetail,
});
