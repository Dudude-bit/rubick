import { createFileRoute } from "@tanstack/react-router";
import { prefetchObject } from "../-object/prefetch";

import { AnyObject } from "../-object/AnyObject";

export const Route = createFileRoute("/c/$cluster/$resource/$name")({
  loader: ({ context, params }) =>
    void prefetchObject(context.queryClient, params),
  component: ClusterScopedObject,
});

function ClusterScopedObject() {
  const { resource, name } = Route.useParams();
  return <AnyObject resource={resource} name={name} />;
}
