import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { ApiCatalog } from "@/generated/types";
import { commands } from "@/lib/commands";
import { errorCode, errorToShow } from "@/lib/error-utils";
import { segmentOf } from "@/lib/access-kinds";
import {
  resourceSegment,
  type ObjectLinkOptions,
  type ObjectRef,
} from "@/lib/links";
import { getApiVersion } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";
import { catalogQuery, servedOf } from "./served";

/**
 * Why an attached object opened on its own page instead of its parent's.
 * Each is a different fact, so each is its own sentence: a target that does
 * not exist and one that could not be read are not the same claim.
 */
export type Stay =
  | { says: "targetMissing"; kind: string; name: string }
  | { says: "targetUnread"; kind: string; name: string; error: string }
  | { says: "targetContested"; kind: string; name: string }
  | { says: "siblingsUnread"; kind: string; name: string }
  | { says: "noService"; name: string }
  | { says: "noOwner" }
  | { says: "involvedGone"; kind: string; name: string };

export type Attachment =
  | { state: "free" }
  | { state: "parent"; parent: ObjectRef; tab?: string }
  | { state: "stay"; stay: Stay };

type Json = Record<string, unknown>;
const FREE: Attachment = { state: "free" };

export interface Target {
  apiVersion?: string;
  kind: string;
  name: string;
  namespace?: string | null;
}

export type Exists = "present" | "missing" | { unread: string };

export interface Reader {
  /** Whether `target` exists, read through the catalogue's plural for its kind. */
  exists(target: Target): Promise<Exists>;
  /** The objects of this kind beside the one being opened. */
  siblings(): Promise<Json[] | null>;
  /** How a parent of `target`'s kind is addressed. */
  refOf(target: Target): ObjectRef;
}

const field = (object: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (at, key) =>
        at && typeof at === "object" ? (at as Json)[key] : undefined,
      object
    );

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

function groupOf(apiVersion: string | undefined): string {
  const slash = apiVersion?.indexOf("/") ?? -1;
  return slash === -1 ? "" : apiVersion!.slice(0, slash);
}

/** An autoscaler goes to what it scales, unless it is not alone there. */
const autoscaler =
  (refPath: string) =>
  async (object: Json, read: Reader): Promise<Attachment> => {
    const ref = field(object, refPath) as Json | undefined;
    const kind = text(ref?.kind);
    const name = text(ref?.name);
    if (!kind || !name) return FREE;
    const target: Target = {
      apiVersion: text(ref?.apiVersion),
      kind,
      name,
      namespace: text(field(object, "metadata.namespace")),
    };
    const exists = await read.exists(target);
    if (exists === "missing")
      return { state: "stay", stay: { says: "targetMissing", kind, name } };
    if (exists !== "present")
      return {
        state: "stay",
        stay: { says: "targetUnread", kind, name, error: exists.unread },
      };
    const siblings = await read.siblings();
    if (!siblings)
      return { state: "stay", stay: { says: "siblingsUnread", kind, name } };
    const aimed = siblings.filter((sibling) => {
      const theirs = field(sibling, refPath) as Json | undefined;
      return (
        text(theirs?.kind) === kind &&
        text(theirs?.name) === name &&
        groupOf(text(theirs?.apiVersion)) === groupOf(target.apiVersion)
      );
    }).length;
    if (aimed > 1)
      return { state: "stay", stay: { says: "targetContested", kind, name } };
    return { state: "parent", parent: read.refOf(target) };
  };

/** Endpoints and their slices belong to the Service whose traffic they carry. */
const service =
  (nameOf: (object: Json) => string | undefined) =>
  async (object: Json, read: Reader): Promise<Attachment> => {
    const name = nameOf(object);
    if (!name) return FREE;
    const target: Target = {
      apiVersion: "v1",
      kind: "Service",
      name,
      namespace: text(field(object, "metadata.namespace")),
    };
    const exists = await read.exists(target);
    if (exists === "missing")
      return { state: "stay", stay: { says: "noService", name } };
    if (exists !== "present")
      return {
        state: "stay",
        stay: {
          says: "targetUnread",
          kind: "Service",
          name,
          error: exists.unread,
        },
      };
    return { state: "parent", parent: read.refOf(target), tab: "endpoints" };
  };

async function revision(object: Json, read: Reader): Promise<Attachment> {
  const owners = (field(object, "metadata.ownerReferences") ?? []) as Json[];
  const owner = owners.find((ref) => ref.controller === true);
  const kind = text(owner?.kind);
  const name = text(owner?.name);
  if (!kind || !name) return { state: "stay", stay: { says: "noOwner" } };
  const target: Target = {
    apiVersion: text(owner?.apiVersion),
    kind,
    name,
    namespace: text(field(object, "metadata.namespace")),
  };
  const exists = await read.exists(target);
  if (exists === "missing")
    return { state: "stay", stay: { says: "targetMissing", kind, name } };
  if (exists !== "present")
    return {
      state: "stay",
      stay: { says: "targetUnread", kind, name, error: exists.unread },
    };
  return { state: "parent", parent: read.refOf(target), tab: "changes" };
}

/** By `<group>/<kind>`: the kinds whose page has an events tab an event can open on. */
const EVENTS_TAB = new Set([
  "/Pod",
  "apps/Deployment",
  "apps/StatefulSet",
  "apps/DaemonSet",
  "apps/ReplicaSet",
  "batch/Job",
  "batch/CronJob",
  "/Node",
  "/Namespace",
  "networking.k8s.io/Ingress",
  "gateway.networking.k8s.io/Gateway",
  "gateway.networking.k8s.io/HTTPRoute",
  "gateway.networking.k8s.io/GRPCRoute",
  "gateway.networking.k8s.io/TCPRoute",
  "gateway.networking.k8s.io/TLSRoute",
  "gateway.networking.k8s.io/UDPRoute",
  "/PersistentVolumeClaim",
]);

const EVENTS_VIA = "events/";

/** Where an Event about `kind` opens: that object's Events tab, noting the Event, if its page has one. */
export function eventLanding(
  kind: string,
  event: { namespace: string; name: string }
): ObjectLinkOptions | undefined {
  if (!EVENTS_TAB.has(`${groupOf(getApiVersion(kind))}/${kind}`))
    return undefined;
  return {
    tab: "events",
    via: `${EVENTS_VIA}${event.namespace}/${event.name}`,
  };
}

/** The tab a page opened with `via` lands on. */
const landingTab = (via: string) =>
  via.startsWith(EVENTS_VIA) ? "events" : undefined;

const event =
  (refPath: string) =>
  async (object: Json, read: Reader): Promise<Attachment> => {
    const ref = field(object, refPath) as Json | undefined;
    const kind = text(ref?.kind);
    const name = text(ref?.name);
    const apiVersion = text(ref?.apiVersion);
    if (!kind || !name || !EVENTS_TAB.has(`${groupOf(apiVersion)}/${kind}`))
      return FREE;
    const target: Target = {
      apiVersion,
      kind,
      name,
      namespace: text(ref?.namespace),
    };
    const exists = await read.exists(target);
    if (exists === "missing")
      return { state: "stay", stay: { says: "involvedGone", kind, name } };
    if (exists !== "present")
      return {
        state: "stay",
        stay: { says: "targetUnread", kind, name, error: exists.unread },
      };
    return { state: "parent", parent: read.refOf(target), tab: "events" };
  };

async function lease(object: Json, read: Reader): Promise<Attachment> {
  const name = text(field(object, "metadata.name"));
  if (field(object, "metadata.namespace") !== "kube-node-lease" || !name)
    return FREE;
  const target: Target = { apiVersion: "v1", kind: "Node", name };
  const exists = await read.exists(target);
  if (exists === "missing")
    return {
      state: "stay",
      stay: { says: "targetMissing", kind: "Node", name },
    };
  if (exists !== "present")
    return {
      state: "stay",
      stay: { says: "targetUnread", kind: "Node", name, error: exists.unread },
    };
  return { state: "parent", parent: read.refOf(target) };
}

/** By `<group>/<plural>`: the kinds whose meaning belongs to one parent. */
const ATTACHED: Record<
  string,
  (object: Json, read: Reader) => Promise<Attachment>
> = {
  "autoscaling/horizontalpodautoscalers": autoscaler("spec.scaleTargetRef"),
  "autoscaling.k8s.io/verticalpodautoscalers": autoscaler("spec.targetRef"),
  "/endpoints": service((object) => text(field(object, "metadata.name"))),
  "discovery.k8s.io/endpointslices": service((object) =>
    text(
      (field(object, "metadata.labels") as Json | undefined)?.[
        "kubernetes.io/service-name"
      ]
    )
  ),
  "apps/controllerrevisions": revision,
  "/events": event("involvedObject"),
  "events.k8s.io/events": event("regarding"),
  "coordination.k8s.io/leases": lease,
};

/** Whether objects of this kind may open on a parent instead of themselves. */
export function isAttached(resource: string): boolean {
  const { group, plural } = servedOf(resource);
  return `${group}/${plural}` in ATTACHED;
}

/**
 * The view a reference to this very object opens with: its own page for an
 * attached kind, since whoever asked for it asked for it and not its parent.
 */
export function ownView(ref: Pick<ObjectRef, "kind" | "crd">) {
  const segment = resourceSegment(ref);
  return segment && isAttached(segment) ? "own" : undefined;
}

/** Where a peek's full page opens: where the object it was opened for lives, else the object itself. */
export function peekLanding(
  target: Pick<ObjectRef, "kind" | "crd"> & { via?: string }
): ObjectLinkOptions {
  return target.via
    ? { tab: landingTab(target.via), via: target.via }
    : { view: ownView(target) };
}

/** Where `object`, named by `resource`, belongs; `free` for unattached kinds. */
export function decide(
  resource: string,
  object: Json,
  read: Reader
): Promise<Attachment> {
  const { group, plural } = servedOf(resource);
  const decideFor = ATTACHED[`${group}/${plural}`];
  return decideFor ? decideFor(object, read) : Promise.resolve(FREE);
}

export function readerOver(
  catalog: ApiCatalog,
  resource: string,
  namespace: string | undefined
): Reader {
  const entryOf = (target: Target) =>
    catalog.entries.find(
      (entry) =>
        entry.kind === target.kind && entry.group === groupOf(target.apiVersion)
    );
  const self = servedOf(resource);
  return {
    async exists(target) {
      const entry = entryOf(target);
      if (!entry) return "missing";
      try {
        await commands.getServedObject(
          entry.group,
          entry.plural,
          target.name,
          entry.namespaced ? (target.namespace ?? null) : null
        );
        return "present";
      } catch (failure) {
        return errorCode(failure) === "NOT_FOUND"
          ? "missing"
          : { unread: errorToShow(failure) };
      }
    },
    async siblings() {
      try {
        const answer = await commands.listServedObjects(
          self.group,
          self.plural,
          namespace ?? null
        );
        return answer.truncated ? null : (answer.items as Json[]);
      } catch {
        return null;
      }
    },
    refOf(target) {
      const entry = entryOf(target);
      return {
        kind: target.kind,
        name: target.name,
        namespace: entry?.namespaced ? target.namespace : null,
        crd: entry && segmentOf(entry),
      };
    },
  };
}

/**
 * Where an attached object opens: on its one parent, read and alone, or on
 * its own page with the reason it did not go there. `undefined` while it
 * is being decided; `free` for every kind this does not apply to.
 */
export function useAttachment(
  resource: string,
  namespace: string | undefined,
  name: string,
  enabled: boolean
): Attachment | undefined {
  const client = useQueryClient();
  const isConnected = useClusterStore((state) => state.isConnected);
  const { group, plural } = servedOf(resource);
  const attached = isAttached(resource);
  const query = useQuery({
    queryKey: ["attachment", resource, namespace ?? null, name],
    queryFn: async () => {
      const [object, catalog] = await Promise.all([
        commands.getServedObject(group, plural, name, namespace ?? null),
        client.query(catalogQuery()),
      ]);
      return decide(
        resource,
        object as Json,
        readerOver(catalog, resource, namespace)
      );
    },
    enabled: enabled && isConnected && attached,
    retry: false,
    staleTime: 30_000,
  });
  if (!attached || !enabled || query.isError) return FREE;
  return query.data;
}
