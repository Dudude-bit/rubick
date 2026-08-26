/**
 * What the AWS Load Balancer Controller's two objects say.
 *
 * `TargetGroupBinding` is the most literal object in this whole tier: it is
 * the wire between a Kubernetes Service and a real ALB or NLB target group,
 * written down. A reader looking at a Service behind an ALB has, today, no
 * way at all to learn which target group it is in — the ARN is sitting in
 * this object on the same API server, and the app shows it as an anonymous
 * custom resource.
 *
 * Its status is one condition and it is worth being precise about, because
 * this is where inventing a verdict would be easiest. The controller writes
 * exactly one condition, of type `Ready`, and it writes it **only when
 * something failed** — `ConditionFalse` with its own message. A binding that
 * is working normally therefore has no conditions at all, so an empty status
 * means "nothing has gone wrong that the controller noticed", and must never
 * be read as either health or breakage.
 *
 * What is *not* here, and cannot be: whether the targets in that group are
 * passing their health checks. That lives in the ELB API, needs a credential,
 * and is the next tier up.
 */

import type { Saying } from "@/i18n/say";
import type { CustomResourceInfo } from "@/generated/types";
import { conditionOf, getValueByPath } from "../kit";

export const TARGET_GROUP_BINDING_CRD = "targetgroupbindings.elbv2.k8s.aws";
export const INGRESS_CLASS_PARAMS_CRD = "ingressclassparams.elbv2.k8s.aws";

const text = (resource: CustomResourceInfo, path: string): string | null => {
  const value = getValueByPath(resource, path);
  return typeof value === "string" && value !== "" ? value : null;
};

/** The Service a binding attaches, in the binding's own namespace. */
export function boundService(binding: CustomResourceInfo): string | null {
  return text(binding, "spec.serviceRef.name");
}

export function boundPort(binding: CustomResourceInfo): string | null {
  const value = getValueByPath(binding, "spec.serviceRef.port");
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The target group, named the way a reader would recognise it.
 *
 * An ARN's last segment is `targetgroup/my-group/0a1b2c3d`, which is the
 * name and the id — the eighty characters of account and region in front of
 * it identify the same thing to nobody reading a chain hop. The whole ARN is
 * still on the object's own page.
 */
export function targetGroupLabel(binding: CustomResourceInfo): string | null {
  const name = text(binding, "spec.targetGroupName");
  if (name) return name;
  const arn = text(binding, "spec.targetGroupARN");
  if (!arn) return null;
  const tail = arn.split(":targetgroup/")[1];
  return tail ? tail.split("/")[0] : arn;
}

/** One line for a chain hop: which group, how targeted, on which port. */
export function bindingSummary(binding: CustomResourceInfo): Saying[] {
  const port = boundPort(binding);
  const parts: Array<Saying | null> = [
    verbatimOrNull(targetGroupLabel(binding)),
    verbatimOrNull(text(binding, "spec.targetType")),
    port === null ? null : { key: "awsPortNumber", values: { port } },
    verbatimOrNull(text(binding, "spec.ipAddressType")),
  ];
  const said = parts.filter((part): part is Saying => part !== null);
  return said.length > 0 ? said : [{ key: "awsNoTargetGroup" }];
}

/** A value the object itself supplied, which is nobody's to translate. */
function verbatimOrNull(said: string | null): Saying | null {
  return said === null ? null : { key: "verbatimLine", values: { said } };
}

/**
 * The controller's own sentence about why this binding is not working, or
 * `null`.
 *
 * Verbatim, and only from a `Ready` condition the controller actually set to
 * `False`. A paraphrase of somebody else's failure is a second guess at it,
 * and — the part that matters more here — a binding with no conditions is
 * the *normal* case and gets nothing said about it in either direction.
 */
export function bindingFailure(binding: CustomResourceInfo): string | null {
  const ready = conditionOf(binding, "Ready");
  if (!ready || ready.status !== "False") return null;
  return (
    // The controller's own words, or nothing: our sentence in this slot
    // would read as its own, which it is not.
    ready.message?.trim() || ready.reason?.trim() || null
  );
}

export function ingressClassParamsSummary(params: CustomResourceInfo): string {
  const parts = [
    text(params, "spec.group.name") === null
      ? null
      : `group ${text(params, "spec.group.name")}`,
    text(params, "spec.scheme"),
    text(params, "spec.ipAddressType"),
    text(params, "spec.loadBalancerName"),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "sets nothing";
}
