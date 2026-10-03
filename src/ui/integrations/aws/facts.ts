/**
 * What the AWS Load Balancer Controller is doing for this cluster right now.
 *
 * The problem line is the strictest in this tier and is meant to be. A
 * `TargetGroupBinding` gets a condition only when the controller failed at
 * something, so the count below is a count of complaints the controller
 * actually wrote — never of bindings that merely look odd, and never of
 * target groups whose *targets* are unhealthy, which is a fact that lives in
 * the ELB API and not in this cluster.
 *
 * That distinction is the whole reason this row can be trusted: an app that
 * guessed at target health from pod readiness would be confidently wrong in
 * exactly the case the reader came here for, since a pod can be Ready to
 * Kubernetes and failing the load balancer's own check.
 */

import { commands } from "@/lib/commands";

import { crdObjectPath, crdObjectsPath } from "../kit";
import type { VendorFact } from "../registry";
import {
  INGRESS_CLASS_PARAMS_CRD,
  TARGET_GROUP_BINDING_CRD,
  bindingFailure,
} from "./model";

export async function facts(): Promise<VendorFact[]> {
  const [bindings, params] = await Promise.all([
    commands.listCustomResources(TARGET_GROUP_BINDING_CRD, null, null, null),
    commands.listCustomResources(INGRESS_CLASS_PARAMS_CRD, null, null, null),
  ]);

  const lines: VendorFact[] = [
    {
      say: [
        {
          key: "kindCount",
          values: { n: bindings.length, kind: "TargetGroupBinding" },
        },
        // Not counted as a kind name: this one is already plural, and
        // "IngressClassParamss" is what pluralising it produces.
        { key: "awsIngressClassParams", values: { n: params.length } },
      ],
    },
  ];

  const failing = bindings.filter(
    (binding) => bindingFailure(binding) !== null
  );
  if (failing.length > 0) {
    lines.push({
      // The controller's own words where there is one of them, because the
      // sentence is the repair — "couldn't find target group" and "access
      // denied" send the reader to two completely different consoles.
      say:
        failing.length === 1
          ? // The controller's own words are not ours to translate.
            {
              key: "verbatimLine" as const,
              values: {
                said: bindingFailure(failing[0]) ?? "",
              },
            }
          : {
              key: "awsBindingsUnapplied" as const,
              values: { n: failing.length },
            },
      tone: "err",
    });
  }

  if (bindings.length > 0) {
    lines.push({
      say: { key: failing.length === 1 ? "factShowIt" : "factShowThem" },
      to:
        failing.length === 1
          ? crdObjectPath(
              TARGET_GROUP_BINDING_CRD,
              failing[0].namespace,
              failing[0].name
            )
          : crdObjectsPath(TARGET_GROUP_BINDING_CRD),
    });
  }

  return lines;
}
