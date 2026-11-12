import { kindFacts } from "@/lib/resource-registry";

/** Groups kubectl resolves by the bare kind; anything else could be two CRDs. */
const BUILT_IN_GROUPS = new Set([
  "",
  "apps",
  "batch",
  "policy",
  "autoscaling",
  "networking.k8s.io",
  "storage.k8s.io",
  "discovery.k8s.io",
  "apiextensions.k8s.io",
]);

/**
 * The command that reads this object from a terminal. A Gateway API kind is
 * spelled with its group, because Istio ships a `gateways` of its own and the
 * bare word answers with whichever kubectl finds first.
 */
export function kubectlGet(object: {
  kind: string;
  name: string;
  namespace?: string | null;
}): string | null {
  const facts = kindFacts(object.kind);
  if (!facts) return null;
  const resource = BUILT_IN_GROUPS.has(facts.group)
    ? facts.kind.toLowerCase()
    : `${facts.plural}.${facts.group}`;
  const where = object.namespace ? ` -n ${object.namespace}` : "";
  return `kubectl get ${resource} ${object.name}${where}`;
}
