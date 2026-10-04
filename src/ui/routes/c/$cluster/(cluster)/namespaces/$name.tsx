import { createFileRoute } from "@tanstack/react-router";
import { prefetchObject } from "../../-object/prefetch";
import { NamespaceDetail } from "@/pages/NamespaceDetail";

export const Route = createFileRoute("/c/$cluster/(cluster)/namespaces/$name")({
  loader: ({ context, params }) =>
    void prefetchObject(context.queryClient, params, "namespaces"),
  component: NamespaceDetail,
});
