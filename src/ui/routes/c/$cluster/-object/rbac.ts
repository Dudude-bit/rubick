import { RBAC_GROUP } from "@/lib/access-kinds";
import type { ServedResource } from "./served";

type Json = Record<string, unknown>;

export interface Rule {
  apiGroups: string[];
  resources: string[];
  resourceNames: string[];
  nonResourceURLs: string[];
  verbs: string[];
}

export interface Subject {
  kind: string;
  name: string;
  namespace: string | null;
}

/** An object an RBAC reference names, addressed by where it is served. */
export interface RbacTarget extends ServedResource {
  kind: string;
  name: string;
  namespace: string | null;
}

const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};

const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const words = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((word): word is string => typeof word === "string")
    : [];

const groupOf = (apiVersion: unknown): string => {
  const version = text(apiVersion) ?? "";
  const slash = version.indexOf("/");
  return slash === -1 ? "" : version.slice(0, slash);
};

export type RbacKind =
  | "Role"
  | "ClusterRole"
  | "RoleBinding"
  | "ClusterRoleBinding";

export function rbacKindOf(object: Json): RbacKind | null {
  if (groupOf(object.apiVersion) !== RBAC_GROUP) return null;
  const kind = text(object.kind);
  return kind === "Role" ||
    kind === "ClusterRole" ||
    kind === "RoleBinding" ||
    kind === "ClusterRoleBinding"
    ? kind
    : null;
}

export function rulesOf(role: Json): Rule[] {
  return (Array.isArray(role.rules) ? role.rules : []).map((entry) => {
    const rule = record(entry);
    return {
      apiGroups: words(rule.apiGroups),
      resources: words(rule.resources),
      resourceNames: words(rule.resourceNames),
      nonResourceURLs: words(rule.nonResourceURLs),
      verbs: words(rule.verbs),
    };
  });
}

export function subjectsOf(binding: Json): Subject[] {
  return (Array.isArray(binding.subjects) ? binding.subjects : []).flatMap(
    (entry) => {
      const subject = record(entry);
      const kind = text(subject.kind);
      const name = text(subject.name);
      return kind && name
        ? [{ kind, name, namespace: text(subject.namespace) }]
        : [];
    }
  );
}

/** Where a subject opens: a ServiceAccount is an object, a User or Group a name. */
export function subjectTarget(
  subject: Subject,
  bindingNamespace: string | null
): RbacTarget | null {
  if (subject.kind !== "ServiceAccount") return null;
  return {
    kind: "ServiceAccount",
    group: "",
    plural: "serviceaccounts",
    name: subject.name,
    namespace: subject.namespace ?? bindingNamespace,
  };
}

/** The Role or ClusterRole a binding grants. */
export function roleRefOf(
  binding: Json,
  bindingNamespace: string | null
): RbacTarget | null {
  const ref = record(binding.roleRef);
  const name = text(ref.name);
  if (!name) return null;
  if (ref.kind === "ClusterRole")
    return {
      kind: "ClusterRole",
      group: RBAC_GROUP,
      plural: "clusterroles",
      name,
      namespace: null,
    };
  if (ref.kind === "Role")
    return {
      kind: "Role",
      group: RBAC_GROUP,
      plural: "roles",
      name,
      namespace: bindingNamespace,
    };
  return null;
}
