import { useEffect } from "react";

import { keptByName } from "@/lib/kept-by-name";
import { toKind } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";

/** Either owner-reference shape: the generated one spells `api_version`. */
export type Owner = {
  kind: string;
  name: string;
  controller?: boolean | null;
} & ({ apiVersion: string } | { api_version: string });

/**
 * What a read says owns its object: the owners, none of them, or `null`
 * where the read does not carry them at all. `undefined` is no read.
 */
export type KnownOwners = Owner[] | null | undefined;

/**
 * Where the last read keeps its owners: a typed read at the top, a manifest
 * under metadata. A manifest leaves the field out when there are none; a
 * typed read with no such field, a Service's or a Secret's, never looked,
 * and "no owners" from it would say nothing puts the object back while the
 * operator that owns it is doing so.
 */
export function ownersOf(data: unknown): KnownOwners {
  if (data === undefined) return undefined;
  const object = data as {
    ownerReferences?: Owner[];
    metadata?: { ownerReferences?: Owner[] };
  };
  if (object.ownerReferences) return object.ownerReferences;
  return object.metadata ? (object.metadata.ownerReferences ?? []) : null;
}

/** Enough for every pod a long session reads; the oldest goes first. */
const KEPT = 2000;
const lastRead = new Map<string, Owner[] | null>();
keptByName(() => lastRead.clear());

interface Named {
  kind: string;
  name: string;
  namespace?: string | null;
  /** Where a kind outside the registry is served: a namesake of a built-in is another object. */
  crd?: string;
}

const keyOf = (context: string | null, { kind, name, namespace, crd }: Named) =>
  JSON.stringify([
    context,
    crd ?? toKind(kind) ?? kind,
    namespace ?? null,
    name,
  ]);

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
    if (owners === undefined) return;
    lastRead.delete(key);
    lastRead.set(key, owners);
    if (lastRead.size > KEPT) lastRead.delete(lastRead.keys().next().value!);
  }, [key, read]);
}

/** The owners the last read of this object named, whenever that was. */
export function useLastOwners(target: Named): KnownOwners {
  const context = useClusterStore((state) => state.currentContext);
  return lastRead.get(keyOf(context, target));
}

/** For tests: a fresh session, with nothing read yet. */
export function forgetLastOwners(): void {
  lastRead.clear();
}
