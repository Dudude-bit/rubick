import { createFileRoute } from "@tanstack/react-router";

import { AnyObject } from "../-object/AnyObject";

export const Route = createFileRoute("/c/$cluster/$resource/$name")({
  component: ClusterScopedObject,
});

function ClusterScopedObject() {
  const { resource, name } = Route.useParams();
  return <AnyObject resource={resource} name={name} />;
}
