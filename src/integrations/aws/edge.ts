/**
 * The target groups a Service is bound into, for the traffic chain.
 *
 * The reference runs the natural way here, unlike GKE's: a
 * `TargetGroupBinding` names its Service, so one list of the namespace's
 * bindings answers for any Service in it and no annotation has to be parsed.
 *
 * What the hop gains is the fact the app could not state at all before —
 * *which* real load balancer target group is behind this Service. A reader
 * looking at an ALB-fronted Service in a vanilla view sees a ClusterIP and
 * nothing else; the ARN was on the same API server the whole time.
 */

import { commands } from "@/lib/commands";

import { crdObjectPath } from "../kit";
import type { EdgeConfig } from "../registry";
import {
  TARGET_GROUP_BINDING_CRD,
  bindingFailure,
  bindingSummary,
  boundService,
} from "./model";

export async function serviceEdge({
  namespace,
  name,
}: {
  namespace: string;
  name: string;
}): Promise<EdgeConfig[]> {
  const bindings = await commands.listCustomResources(
    TARGET_GROUP_BINDING_CRD,
    namespace,
    null,
    null
  );

  return bindings
    .filter((binding) => boundService(binding) === name)
    .map((binding): EdgeConfig => {
      const failure = bindingFailure(binding);
      return {
        source: {
          kind: "TargetGroupBinding",
          name: binding.name,
          to: crdObjectPath(
            TARGET_GROUP_BINDING_CRD,
            binding.namespace,
            binding.name
          ),
        },
        summary: bindingSummary(binding),
        // Verbatim, and only where the controller wrote a failing `Ready`
        // condition. A binding with no conditions — which is every binding
        // that is working, and every binding on a cluster whose controller
        // is not running — says nothing here rather than saying "fine".
        problem:
          failure === null
            ? null
            : {
                text: { key: "verbatimLine", values: { said: failure } },
                tone: "err",
              },
      };
    });
}
