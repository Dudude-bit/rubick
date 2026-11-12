import {
  getResourceDefinition,
  isResourceType,
  toKind,
} from "@/lib/resource-registry";

export interface ServedResource {
  group: string;
  plural: string;
}

/**
 * The group and plural an address names: `<plural>.<group>`, or a bare
 * plural, which is the registry's group where it knows the kind and the core
 * group where it does not, as kubectl reads it.
 */
export function servedOf(segment: string): ServedResource {
  const dot = segment.indexOf(".");
  if (dot !== -1)
    return { plural: segment.slice(0, dot), group: segment.slice(dot + 1) };
  const kind = isResourceType(segment) ? toKind(segment) : null;
  return {
    plural: segment,
    group: kind ? getResourceDefinition(kind).group : "",
  };
}

/** By `<group>/<plural>`: the kinds whose meaning belongs to one parent, where a bare address opens them. */
export const ATTACHED_KINDS = [
  "autoscaling/horizontalpodautoscalers",
  "autoscaling.k8s.io/verticalpodautoscalers",
  "/endpoints",
  "discovery.k8s.io/endpointslices",
  "apps/controllerrevisions",
  "/events",
  "events.k8s.io/events",
  "coordination.k8s.io/leases",
] as const;

export type AttachedKind = (typeof ATTACHED_KINDS)[number];

const ATTACHED = new Set<string>(ATTACHED_KINDS);

/** Whether objects of this kind may open on a parent instead of themselves. */
export function isAttached(segment: string): boolean {
  const { group, plural } = servedOf(segment);
  return ATTACHED.has(`${group}/${plural}`);
}
