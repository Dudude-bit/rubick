import { useEffect } from "react";

import { toKind } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";

/** Either owner-reference shape: the generated one spells `api_version`. */
export type Owner = {
  kind: string;
  name: string;
  controller?: boolean | null;
} & ({ apiVersion: string } | { api_version: string });

/** Where the last read keeps its owners: a typed read at the top, a manifest under metadata. */
export function ownersOf(data: unknown): Owner[] | undefined {
  if (data === undefined) return undefined;
  const object = data as {
    ownerReferences?: Owner[];
    metadata?: { ownerReferences?: Owner[] };
  };
  return object.ownerReferences ?? object.metadata?.ownerReferences ?? [];
}

/** Enough for every pod a long session reads; the oldest goes first. */
const KEPT = 2000;
const lastRead = new Map<string, Owner[]>();

interface Named {
  kind: string;
  name: string;
  namespace?: string | null;
}

const keyOf = (context: string | null, { kind, name, namespace }: Named) =>
  JSON.stringify([context, toKind(kind) ?? kind, namespace ?? null, name]);

/**
 * Keeps the owners each read of this object named, past the query cache: a
 * tab or cluster switch drops every query, and a pod gone by the next read
 * then had no owner to point at. `read` is this object's own answer, never a
 * placeholder from the one before.
 */
export function useRememberOwners(target: Named, read: unknown): void {
  const context = useClusterStore((state) => state.currentContext);
  const key = keyOf(context, target);
  useEffect(() => {
    const owners = ownersOf(read);
    if (!owners) return;
    lastRead.delete(key);
    lastRead.set(key, owners);
    if (lastRead.size > KEPT) lastRead.delete(lastRead.keys().next().value!);
  }, [key, read]);
}

/** The owners the last read of this object named, whenever that was. */
export function useLastOwners(target: Named): Owner[] | undefined {
  const context = useClusterStore((state) => state.currentContext);
  return lastRead.get(keyOf(context, target));
}

/** For tests: a fresh session, with nothing read yet. */
export function forgetLastOwners(): void {
  lastRead.clear();
}
