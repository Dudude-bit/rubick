import {
  IdCard,
  Link,
  Link2,
  Scroll,
  ScrollText,
  type LucideIcon,
} from "lucide-react";

export const RBAC_GROUP = "rbac.authorization.k8s.io";

/** A built-in kind with no page of its own, opened on the generic one. */
export interface AccessKind {
  kind: string;
  group: string;
  plural: string;
  namespaced: boolean;
  icon: LucideIcon;
}

/** Who a request is made as, and what it may do: the kinds RBAC is read from. */
export const ACCESS_KINDS: readonly AccessKind[] = [
  {
    kind: "ServiceAccount",
    group: "",
    plural: "serviceaccounts",
    namespaced: true,
    icon: IdCard,
  },
  {
    kind: "Role",
    group: RBAC_GROUP,
    plural: "roles",
    namespaced: true,
    icon: ScrollText,
  },
  {
    kind: "RoleBinding",
    group: RBAC_GROUP,
    plural: "rolebindings",
    namespaced: true,
    icon: Link2,
  },
  {
    kind: "ClusterRole",
    group: RBAC_GROUP,
    plural: "clusterroles",
    namespaced: false,
    icon: Scroll,
  },
  {
    kind: "ClusterRoleBinding",
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

/** `<plural>.<group>`, or the bare plural of a core kind, as kubectl names it. */
export function segmentOf(entry: { group: string; plural: string }): string {
  return entry.group ? `${entry.plural}.${entry.group}` : entry.plural;
}

/** The address segment an access kind opens at, or `undefined` for any other. */
export function accessSegment(kind: string): string | undefined {
  const entry = accessKind(kind);
  return entry && segmentOf(entry);
}
