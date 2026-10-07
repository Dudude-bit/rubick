import type { AccessAnswer, AccessQuery } from "@/generated/types";

interface Rule {
  groups: string[];
  resources: string[];
  verbs: string[];
}

/** Role `developer` in team-checkout, bound to ServiceAccount marco, as the live cluster has it. */
const DEVELOPER: Rule[] = [
  {
    groups: [""],
    resources: [
      "pods",
      "services",
      "endpoints",
      "configmaps",
      "secrets",
      "events",
      "persistentvolumeclaims",
      "serviceaccounts",
    ],
    verbs: ["get", "list", "watch"],
  },
  { groups: [""], resources: ["pods"], verbs: ["delete"] },
  { groups: [""], resources: ["pods/log"], verbs: ["get"] },
  {
    groups: [""],
    resources: ["pods/exec", "pods/portforward"],
    verbs: ["create", "get"],
  },
  {
    groups: ["apps"],
    resources: ["deployments", "replicasets", "statefulsets"],
    verbs: ["get", "list", "watch", "patch", "update"],
  },
  {
    groups: ["apps"],
    resources: ["deployments/scale"],
    verbs: ["get", "patch", "update"],
  },
  {
    groups: ["batch"],
    resources: ["jobs", "cronjobs"],
    verbs: ["get", "list", "watch", "create", "delete"],
  },
  {
    groups: ["autoscaling"],
    resources: ["horizontalpodautoscalers"],
    verbs: ["get", "list", "watch"],
  },
];

/** What `kubectl auth can-i` answers Marco, matched the way the RBAC authorizer matches. */
export function marcoMay(query: AccessQuery): boolean {
  if (query.namespace !== "team-checkout") return false;
  const { subresource } = query as { subresource?: string | null };
  const resource = subresource
    ? `${query.resource}/${subresource}`
    : query.resource;
  return DEVELOPER.some(
    (rule) =>
      rule.groups.includes(query.group) &&
      rule.resources.includes(resource) &&
      rule.verbs.includes(query.verb)
  );
}

/** `checkAccess` as the cluster answers it for Marco. */
export async function marcoReview(
  queries: AccessQuery[]
): Promise<AccessAnswer[]> {
  return queries.map((query) => ({
    verb: query.verb,
    resource: query.resource,
    allowed: marcoMay(query),
  }));
}
