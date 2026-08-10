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

import { crdObjectPath, crdObjectsPath, plural } from "../kit";
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
      text: [
        plural(bindings.length, "TargetGroupBinding"),
        // Not through `plural`: the kind's own name is already plural, and
        // "IngressClassParamss" is what adding an s to it produces.
        `${params.length} IngressClassParams`,
      ].join(" · "),
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
      text:
        failing.length === 1
          ? (bindingFailure(failing[0]) ?? "not ready")
          : `${plural(failing.length, "binding")} the controller could not apply`,
      tone: "err",
    });
  }

  if (bindings.length > 0) {
    lines.push({
      text: failing.length === 1 ? "Show it" : "Show them",
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
