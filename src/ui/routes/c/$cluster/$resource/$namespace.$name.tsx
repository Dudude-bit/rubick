import { createFileRoute } from "@tanstack/react-router";

import { AnyObject } from "../-object/AnyObject";

export const Route = createFileRoute("/c/$cluster/$resource/$namespace/$name")({
  component: NamespacedObject,
});

function NamespacedObject() {
  const { resource, namespace, name } = Route.useParams();
  return <AnyObject resource={resource} namespace={namespace} name={name} />;
}
