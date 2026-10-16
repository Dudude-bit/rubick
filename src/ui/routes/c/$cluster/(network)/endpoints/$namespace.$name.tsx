import { createFileRoute } from "@tanstack/react-router";
import { AttachedGate } from "../../-object/Attached";
import { prefetchObject } from "../../-object/prefetch";
import { EndpointsDetail } from "./-components/EndpointsDetail";

export const Route = createFileRoute(
  "/c/$cluster/(network)/endpoints/$namespace/$name"
)({
  loader: ({ context, params }) =>
    void prefetchObject(context.queryClient, params, "endpoints"),
  component: EndpointsRoute,
});

/** Endpoints a Service keeps open on that Service; hand-kept ones stay here. */
function EndpointsRoute() {
  const { namespace, name } = Route.useParams();
  return (
    <AttachedGate resource="endpoints" namespace={namespace} name={name}>
      <EndpointsDetail />
    </AttachedGate>
  );
}
