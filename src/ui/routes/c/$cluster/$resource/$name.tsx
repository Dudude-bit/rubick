import { createFileRoute, redirect } from "@tanstack/react-router";
import { prefetchObject } from "../-object/prefetch";

import { AnyObject } from "../-object/AnyObject";
import {
  catalogQuery,
  segmentNamespaced,
  servedIn,
  servedOf,
} from "../-object/served";
import { namespaceListLink } from "@/lib/links";
import type { ApiCatalog } from "@/generated/types";

export const Route = createFileRoute("/c/$cluster/$resource/$name")({
  // One segment under a namespaced kind names a namespace, not an object.
  beforeLoad: ({ context, params }) => {
    const catalog = context.queryClient.getQueryData<ApiCatalog>(
      catalogQuery().queryKey
    );
    const served = servedIn(catalog, undefined, servedOf(params.resource));
    if (segmentNamespaced(params.resource, served))
      throw redirect({
        ...namespaceListLink(params.resource, params.name),
        replace: true,
      });
  },
  loader: ({ context, params }) =>
    void prefetchObject(context.queryClient, params),
  component: ClusterScopedObject,
});

function ClusterScopedObject() {
  const { resource, name } = Route.useParams();
  return <AnyObject resource={resource} name={name} />;
}
