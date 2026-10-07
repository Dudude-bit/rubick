import {
  IdCard,
  Link,
  Link2,
  Scroll,
  ScrollText,
  type LucideIcon,
} from "lucide-react";

import type { ResourceCounts } from "@/generated/types";

export const RBAC_GROUP = "rbac.authorization.k8s.io";

/** A built-in kind with no page of its own, opened on the generic one. */
export interface AccessKind {
  kind: string;
  displayPlural: string;
  group: string;
  plural: string;
  namespaced: boolean;
  icon: LucideIcon;
  /** The overview count that belongs beside its row in the sidebar, where the backend counts the kind. */
  count?: keyof ResourceCounts;
}

/** Who a request is made as, and what it may do: the kinds RBAC is read from. */
export const ACCESS_KINDS: readonly AccessKind[] = [
  {
    kind: "ServiceAccount",
    displayPlural: "ServiceAccounts",
    group: "",
    plural: "serviceaccounts",
    namespaced: true,
    icon: IdCard,
    count: "serviceAccounts",
  },
  {
    kind: "Role",
    displayPlural: "Roles",
    group: RBAC_GROUP,
    plural: "roles",
    namespaced: true,
    icon: ScrollText,
  },
  {
    kind: "RoleBinding",
    displayPlural: "RoleBindings",
    group: RBAC_GROUP,
    plural: "rolebindings",
    namespaced: true,
    icon: Link2,
  },
  {
    kind: "ClusterRole",
    displayPlural: "ClusterRoles",
    group: RBAC_GROUP,
    plural: "clusterroles",
    namespaced: false,
    icon: Scroll,
  },
  {
    kind: "ClusterRoleBinding",
    displayPlural: "ClusterRoleBindings",
    group: RBAC_GROUP,
    plural: "clusterrolebindings",
    namespaced: false,
    icon: Link,
  },
];

const BY_KIND = new Map(ACCESS_KINDS.map((entry) => [entry.kind, entry]));

export function accessKind(kind: string): AccessKind | undefined {
  return BY_KIND.get(kind);
}

/** What a list of this kind is called: an access kind's plural, or else the kind as the cluster spells it. */
export function listTitleOf(entry: { kind: string; group: string }): string {
  const access = accessKind(entry.kind);
  return access?.group === entry.group ? access.displayPlural : entry.kind;
}

/** `<plural>.<group>`, or the bare plural of a core kind, as kubectl names it. */
export function segmentOf(entry: { group: string; plural: string }): string {
  return entry.group ? `${entry.plural}.${entry.group}` : entry.plural;
}

/** The address segment an access kind opens at, or `undefined` for any other. */
export function accessSegment(kind: string): string | undefined {
  const entry = accessKind(kind);
  return entry && segmentOf(entry);
}
