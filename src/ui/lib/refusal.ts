/**
 * What a 403 from the API server says, read back out of its sentence.
 *
 * The server writes the whole refusal in one line: who, which verb, which
 * resource, which group, which namespace. That is everything a Role needs,
 * so the rule to ask an administrator for is the refusal turned around, not
 * something guessed from the kubeconfig's user alias.
 */

export interface Refusal {
  user: string;
  verb: string;
  /** `pods`, or `pods/log` for a subresource. */
  resource: string;
  group: string;
  /** `null` at the cluster scope. */
  namespace: string | null;
}

const SENTENCE =
  /User "([^"]+)" cannot (\w+) resource "([^"]+)"(?: in API group "([^"]*)")?(?: in the namespace "([^"]+)"| at the cluster scope)?/;

export function parseRefusal(message: string): Refusal | null {
  const m = SENTENCE.exec(message);
  if (!m) return null;
  return {
    user: m[1],
    verb: m[2],
    resource: m[3],
    group: m[4] ?? "",
    namespace: m[5] ?? null,
  };
}

const READ_VERBS = ["get", "list", "watch"];

function dnsLabel(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

function subject(user: string): string {
  const sa = /^system:serviceaccount:([^:]+):(.+)$/.exec(user);
  if (sa) {
    return `- kind: ServiceAccount\n  name: ${sa[2]}\n  namespace: ${sa[1]}`;
  }
  return `- kind: User\n  name: ${user}\n  apiGroup: rbac.authorization.k8s.io`;
}

/**
 * A Role and RoleBinding (or their cluster-scoped pair) that would have let
 * the refused read through. A read verb asks for all three read verbs, because
 * a list without a watch is a screen that never updates.
 */
export function rbacRule(refusal: Refusal): string {
  const verbs = READ_VERBS.includes(refusal.verb) ? READ_VERBS : [refusal.verb];
  const scoped = refusal.namespace !== null;
  const role = scoped ? "Role" : "ClusterRole";
  const binding = scoped ? "RoleBinding" : "ClusterRoleBinding";
  const name = dnsLabel(`rubick-${refusal.verb}-${refusal.resource}`);
  const ns = scoped ? `\n  namespace: ${refusal.namespace}` : "";
  const where = scoped
    ? `in namespace ${refusal.namespace}`
    : "at the cluster scope";
  return [
    `# Rubick was refused: ${refusal.user} cannot ${refusal.verb} ${refusal.resource} ${where}.`,
    `apiVersion: rbac.authorization.k8s.io/v1`,
    `kind: ${role}`,
    `metadata:`,
    `  name: ${name}${ns}`,
    `rules:`,
    `- apiGroups: ["${refusal.group}"]`,
    `  resources: ["${refusal.resource}"]`,
    `  verbs: [${verbs.map((v) => `"${v}"`).join(", ")}]`,
    `---`,
    `apiVersion: rbac.authorization.k8s.io/v1`,
    `kind: ${binding}`,
    `metadata:`,
    `  name: ${name}${ns}`,
    `roleRef:`,
    `  apiGroup: rbac.authorization.k8s.io`,
    `  kind: ${role}`,
    `  name: ${name}`,
    `subjects:`,
    subject(refusal.user),
    ``,
  ].join("\n");
}
