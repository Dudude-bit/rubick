import { createFileRoute } from "@tanstack/react-router";
import { prefetchObject } from "../../-object/prefetch";
import { NodeDetail } from "./-components/NodeDetail";

export const Route = createFileRoute("/c/$cluster/(cluster)/nodes/$name")({
  loader: ({ context, params }) =>
    void prefetchObject(context.queryClient, params, "nodes"),
  component: NodeDetail,
});
