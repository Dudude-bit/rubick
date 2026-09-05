/**
 * The vocabulary a vendor folder is written in.
 *
 * Generic, and here rather than in `src/lib/` all the same: a helper whose
 * only callers are vendor folders is part of how a vendor is declared. The
 * rule this tree enforces is that vendor *knowledge* has one home, not that
 * the tree is free of plain functions.
 */

import type { en } from "@/i18n/catalogue";
import type { T } from "@/i18n/useT";
import type {
  CustomResourceInfo,
  CustomResourceDetailInfo,
} from "@/generated/types";
import { getCustomResourceUrl } from "@/lib/navigation-utils";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import type { CrdView } from "./registry";

const CRDS = toPlural(ResourceType.CustomResourceDefinition);

/**
 * The route to the objects of one CRD, and to one of them.
 *
 * Built here rather than per vendor because it has already drifted once: a
 * literal `/crds/…` in a vendor folder named a segment no route has, and the
 * link went nowhere with nothing to say so.
 */
export function crdObjectsPath(crdName: string): string {
  return `/${CRDS}/${encodeURIComponent(crdName)}?tab=instances`;
}

/**
 * Kept as the vendor tree's spelling of it — the argument order reads
 * `where, then which` at every call site here — over the core function that
 * now owns the route, because `ResourceRef` needs the same path and cannot
 * import from this tree.
 */
export function crdObjectPath(
  crdName: string,
  namespace: string | null,
  name: string
): string {
  return getCustomResourceUrl(crdName, name, namespace);
}

/**
 * The one line a vendor row shows about itself, and how to colour it.
 *
 * Three tones for four things to say: a vendor that cannot reach its own
 * backend files "could not look" under `warn`, the same tone as a real
 * warning. Widening this to say so is one edit here, and the call sites to
 * change are the ones that reference this name.
 */
export interface VendorVerdict {
  text: string;
  tone: "ok" | "warn" | "err";
}

/**
 * One entry of the `status.conditions` array every operator writes.
 *
 * The one shape a vendor's objects genuinely share with every other vendor's:
 * a type, a status, and the controller's own sentence about why. That message
 * is never paraphrased anywhere in this tree; a rewritten error is a second
 * guess at somebody else's failure.
 */
export interface VendorCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export function conditionsOf(
  resource: CustomResourceInfo | CustomResourceDetailInfo
): VendorCondition[] {
  const conditions = getValueByPath(resource, "status.conditions");
  return Array.isArray(conditions) ? (conditions as VendorCondition[]) : [];
}

/** One condition by type, or `null` where the controller has not written it. */
export function conditionOf(
  resource: CustomResourceInfo | CustomResourceDetailInfo,
  conditionType: string
): VendorCondition | null {
  return (
    conditionsOf(resource).find(
      (condition) => condition.type === conditionType
    ) ?? null
  );
}

/**
 * The `Ready` condition's status, for the several vendors whose objects
 * all state health the same way — `"True"`, `"False"`, or `null` where the
 * controller has not written one yet.
 */
export function readyStatus(
  resource: CustomResourceInfo | CustomResourceDetailInfo,
  conditionType: string = "Ready"
): string | null {
  return conditionOf(resource, conditionType)?.status ?? null;
}

/** A column a vendor adds to the list of one of its own kinds. */
export interface CrdColumn {
  id: string;
  /**
   * The heading, as a catalogue key. These tables are built once at import,
   * where the reader's language is not yet known and would be frozen in if
   * it were.
   */
  header: keyof (typeof en)["columns"];
  /** Takes the translator: some of these compose a sentence per row. */
  accessor: (resource: CustomResourceInfo, t: T) => unknown;
  /** Without one the value is stringified, and `null` draws an em dash. */
  cell?: (value: unknown, t: T) => React.ReactNode;
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
        Array<{ type: string; status: string }> | undefined;

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
 * For a vendor whose objects carry no status at all. Named rather than made
 * optional: a vendor that has not decided is different from one whose
 * resources genuinely do not report health.
 */
export const NO_STATUS: CrdStatus = {
  getStatus: () => null,
  getVariant: () => "outline",
};
