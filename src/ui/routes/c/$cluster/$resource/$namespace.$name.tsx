import { createFileRoute } from "@tanstack/react-router";
import { prefetchObject } from "../-object/prefetch";

import { AnyObject } from "../-object/AnyObject";

export const Route = createFileRoute("/c/$cluster/$resource/$namespace/$name")({
  loader: ({ context, params }) =>
    void prefetchObject(context.queryClient, params),
  component: NamespacedObject,
});

function NamespacedObject() {
  const { resource, namespace, name } = Route.useParams();
  return <AnyObject resource={resource} namespace={namespace} name={name} />;
}
