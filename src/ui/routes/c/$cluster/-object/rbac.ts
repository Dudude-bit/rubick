import type { BindingInfo } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { RBAC_GROUP } from "@/lib/access-kinds";
import type { WordTable } from "../-peek/peek-sources-kit";
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
  const kind = text(ref.kind);
  return name && kind ? roleTarget({ kind, name }, bindingNamespace) : null;
}

export function roleTarget(
  ref: { kind: string; name: string },
  bindingNamespace: string | null
): RbacTarget | null {
  if (ref.kind === "ClusterRole")
    return {
      kind: "ClusterRole",
      group: RBAC_GROUP,
      plural: "clusterroles",
      name: ref.name,
      namespace: null,
    };
  if (ref.kind === "Role")
    return {
      kind: "Role",
      group: RBAC_GROUP,
      plural: "roles",
      name: ref.name,
      namespace: bindingNamespace,
    };
  return null;
}

/** Verbs that let the holder reach past what the rule names. */
const ESCALATING_VERBS = new Set(["escalate", "bind", "impersonate"]);

const coversSecrets = (rule: Rule) =>
  rule.apiGroups.some((group) => group === "" || group === "*") &&
  rule.resources.some((resource) => resource === "secrets" || resource === "*");

/** The verbs of one rule that grant more than they say. */
export function escalatingVerbs(rule: Rule): string[] {
  return rule.verbs.filter(
    (verb) =>
      ESCALATING_VERBS.has(verb) || (verb === "*" && coversSecrets(rule))
  );
}

export function rulesTable(rules: Rule[], t: T): WordTable {
  const urls = rules.some((rule) => rule.nonResourceURLs.length > 0);
  return {
    columns: [
      "apiGroups",
      "resources",
      "resourceNames",
      "verbs",
      ...(urls ? ["nonResourceURLs"] : []),
    ],
    rows: rules.map((rule) => {
      const escalating = escalatingVerbs(rule);
      return [
        { words: rule.apiGroups.map((group) => group || '""') },
        { words: rule.resources },
        {
          words: rule.resourceNames,
          none: rule.resources.length ? t("rbac", "anyName") : undefined,
        },
        escalating.length
          ? { words: rule.verbs, escalating }
          : { words: rule.verbs },
        ...(urls ? [{ words: rule.nonResourceURLs }] : []),
      ];
    }),
  };
}

/**
 * How a binding reaches one ServiceAccount: named, as itself or as its user
 * name, or through a group every such account is in. Most direct first.
 */
export const REACHES = [
  "account",
  "namespaceGroup",
  "everyAccount",
  "authenticated",
] as const;
export type Reach = (typeof REACHES)[number];

export interface Account {
  name: string;
  namespace: string;
}

function subjectReach(
  subject: Subject,
  bindingNamespace: string | null,
  account: Account
): Reach | null {
  switch (subject.kind) {
    case "ServiceAccount":
      return subject.name === account.name &&
        (subject.namespace ?? bindingNamespace) === account.namespace
        ? "account"
        : null;
    case "User":
      return subject.name ===
        `system:serviceaccount:${account.namespace}:${account.name}`
        ? "account"
        : null;
    case "Group":
      if (subject.name === `system:serviceaccounts:${account.namespace}`)
        return "namespaceGroup";
      if (subject.name === "system:serviceaccounts") return "everyAccount";
      if (subject.name === "system:authenticated") return "authenticated";
      return null;
    default:
      return null;
  }
}

export interface Grant {
  binding: BindingInfo;
  reach: Reach;
}

/** The bindings that grant one ServiceAccount anything, most direct first. */
export function grantsTo(bindings: BindingInfo[], account: Account): Grant[] {
  const grants: Grant[] = [];
  for (const binding of bindings) {
    const reaches = binding.subjects.flatMap((subject) => {
      const reach = subjectReach(subject, binding.namespace, account);
      return reach ? [reach] : [];
    });
    if (reaches.length === 0) continue;
    const reach = REACHES.find((candidate) => reaches.includes(candidate))!;
    grants.push({ binding, reach });
  }
  return grants.sort(
    (a, b) =>
      REACHES.indexOf(a.reach) - REACHES.indexOf(b.reach) ||
      a.binding.kind.localeCompare(b.binding.kind) ||
      a.binding.name.localeCompare(b.binding.name)
  );
}

/** The bindings that grant one role, which for a Role are its namespace's. */
export function bindingsOf(
  bindings: BindingInfo[],
  role: { kind: "Role" | "ClusterRole"; name: string; namespace: string | null }
): BindingInfo[] {
  return bindings
    .filter(
      (binding) =>
        binding.roleRef.kind === role.kind &&
        binding.roleRef.name === role.name &&
        (role.kind === "ClusterRole" || binding.namespace === role.namespace)
    )
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        (a.namespace ?? "").localeCompare(b.namespace ?? "") ||
        a.name.localeCompare(b.name)
    );
}
