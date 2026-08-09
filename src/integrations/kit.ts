/**
 * The vocabulary a vendor folder is written in.
 *
 * Generic, and here rather than in `src/lib/` all the same: nothing outside
 * this tree uses any of it, and a helper whose only callers are vendor
 * folders is part of how a vendor is declared. The rule that keeps this
 * tree honest is about vendor *knowledge* having one home, not about the
 * tree being free of plain functions.
 */

import type {
  CustomResourceInfo,
  CustomResourceDetailInfo,
} from "@/generated/types";
import type { CrdView } from "./registry";

/** A column a vendor adds to the list of one of its own kinds. */
export interface CrdColumn {
  id: string;
  header: string;
  accessor: (resource: CustomResourceInfo) => unknown;
  /** Without one the value is stringified, and `null` draws an em dash. */
  cell?: (value: unknown) => React.ReactNode;
}

export interface CrdStatus {
  getStatus: (
    resource: CustomResourceInfo | CustomResourceDetailInfo
  ) => string | null;
  getVariant: (
    status: string
  ) => "default" | "secondary" | "destructive" | "outline";
}

/** Matches every kind in one API group. */
export function matchByGroup(targetGroup: string): CrdView["matches"] {
  const normalizedTarget = targetGroup.toLowerCase();
  return (group) => group.toLowerCase() === normalizedTarget;
}

/**
 * Matches a list of `[group]` or `[group, kind]` pairs — for a vendor that
 * owns some of a shared group's kinds and not the rest of it.
 */
export function matchMultiple(
  matchers: Array<[string, string?]>
): CrdView["matches"] {
  const normalizedMatchers = matchers.map(([group, kind]) => ({
    group: group.toLowerCase(),
    kind: kind?.toLowerCase(),
  }));

  return (group, kind) => {
    const normalizedGroup = group.toLowerCase();
    const normalizedKind = kind.toLowerCase();

    return normalizedMatchers.some(
      (m) =>
        m.group === normalizedGroup &&
        (m.kind === undefined || m.kind === normalizedKind)
    );
  };
}

/** Matches a group by pattern — for a vendor that renamed its API group. */
export function matchByPattern(groupPattern: RegExp): CrdView["matches"] {
  return (group) => groupPattern.test(group);
}

/**
 * Read `spec.secretName` or `status.conditions[0].type` off a resource whose
 * shape is only known to the vendor that installed the CRD.
 */
export function getValueByPath(
  resource: CustomResourceInfo | CustomResourceDetailInfo,
  path: string
): unknown {
  const parts = path.split(".");
  let current: unknown = resource;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;

    const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
    if (arrayMatch) {
      const [, key, index] = arrayMatch;
      current = (current as Record<string, unknown>)[key];
      if (Array.isArray(current)) {
        current = current[parseInt(index, 10)];
      } else {
        return undefined;
      }
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }

  return current;
}

/**
 * `Ready` from a conditions array, which is how most operators state health.
 */
export function conditionStatus(conditionType: string = "Ready"): CrdStatus {
  return {
    getStatus: (resource) => {
      const conditions = getValueByPath(resource, "status.conditions") as
        | Array<{ type: string; status: string }>
        | undefined;

      if (!Array.isArray(conditions)) return null;

      const condition = conditions.find((c) => c.type === conditionType);
      if (!condition) return null;

      return condition.status === "True" ? "Ready" : "NotReady";
    },
    getVariant: (status) => {
      const normalized = status.toLowerCase();
      if (normalized === "ready" || normalized === "true") return "default";
      if (normalized === "notready" || normalized === "false")
        return "destructive";
      return "secondary";
    },
  };
}

/**
 * For a vendor whose objects carry no status at all. Naming it is better
 * than four copies of the same two stub functions, and better than making
 * `status` optional: a vendor that has not decided is different from one
 * whose resources genuinely do not report health.
 */
export const NO_STATUS: CrdStatus = {
  getStatus: () => null,
  getVariant: () => "outline",
};
