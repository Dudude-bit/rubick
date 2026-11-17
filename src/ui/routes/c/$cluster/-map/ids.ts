import { kindFacts } from "@/lib/resource-registry";

/** What a node's id is made of: the object it draws. */
export interface NodeIdParts {
  /** Absent for a built-in kind, whose group `kinds.json` knows. */
  group?: string | null;
  kind: string;
  namespace?: string | null;
  name: string;
}

/**
 * `{group}/{kind}/{namespace}/{name}`, as the backend spells every node it
 * sends: a flow naming a workload finds that workload's node by this alone.
 * Held to the backend's `node_id` by `src/contracts/topology-ids.json`.
 */
export function nodeId(object: NodeIdParts): string {
  const group = object.group ?? kindFacts(object.kind)?.group ?? "";
  return `${group}/${object.kind}/${object.namespace ?? ""}/${object.name}`;
}
