import type { AnyRouter, LinkOptions } from "@tanstack/react-router";

import {
  getResourceDefinition,
  isResourceType,
  listedElsewhere,
  listSegment,
  toKind,
  toPlural,
  type ResourceKind,
} from "./resource-registry";
import { accessKind, segmentOf, type AccessKind } from "./access-kinds";

/**
 * Every in-app address is built here. A link is the router's own options
 * object, so `to` is checked against the route tree at compile time; a string
 * only exists where something has to store one (a tab, a deep link, a row's
 * `href`), and it comes from {@link hrefOf}.
 */
export type AppLink = LinkOptions;

export interface ObjectRef {
  kind: string;
  name: string;
  namespace?: string | null;
  /**
   * `<plural>.<group>` for a custom resource, which the registry cannot
   * spell; `null` for a namesake of a built-in kind nothing here addresses.
   */
  crd?: string | null;
}

export interface ObjectLinkOptions {
  tab?: string;
  cluster?: string;
  via?: string;
  /** `own` opens an attached object itself rather than its parent. */
  view?: string;
}

type ClusterParams = { cluster?: string };

const inCluster =
  <T extends object>(rest: T, cluster?: string) =>
  (prev: ClusterParams) => ({
    cluster: cluster ?? prev.cluster ?? "",
    ...rest,
  });

/** Whether the registry calls this kind cluster-scoped. Unknown kinds are not. */
export function isClusterScoped(kind: ResourceKind | string): boolean {
  const resolved = toKind(kind);
  return (
    resolved !== null && getResourceDefinition(resolved).scope === "cluster"
  );
}

/**
 * The URL segment that names a resource the way kubectl does: the plural of
 * a kind the registry knows, `<plural>.<group>` for a custom resource.
 */
export function resourceSegment(ref: Pick<ObjectRef, "kind" | "crd">) {
  if (ref.crd) return ref.crd;
  const kind = isResourceType(ref.kind) ? toKind(ref.kind) : null;
  return kind ? toPlural(kind) : null;
}

/** The built-in access kind a reference names, unless its CRD says otherwise. */
function accessOf(ref: ObjectRef): AccessKind | undefined {
  const access = accessKind(ref.kind);
  return access && (!ref.crd || ref.crd === segmentOf(access))
    ? access
    : undefined;
}

/** A segment that names the registry's own kind is that kind, page and peek. */
function ownCrd(ref: ObjectRef): string | undefined {
  const known = ref.crd && isResourceType(ref.kind) ? toKind(ref.kind) : null;
  return known && segmentOf(getResourceDefinition(known)) === ref.crd
    ? undefined
    : (ref.crd ?? undefined);
}

/** The segment a reference is read through: its CRD's, or an access kind's. */
export function crdFor(ref: ObjectRef): string | undefined {
  const access = accessOf(ref);
  return ownCrd(ref) ?? (access && segmentOf(access));
}

/**
 * The segment of a reference that knows its group but not its plural: none
 * for the built-in kind of that very group, the cluster's CRD for any other,
 * and `null` while no CRD names it, so a namesake never opens the built-in.
 */
export function crdInGroup(
  ref: { kind: string; group: string | null },
  crdOf: (group: string, kind: string) => string | null
): string | null | undefined {
  const group = ref.group ?? "";
  return isBuiltInGroup(ref.kind, group) ? undefined : crdOf(group, ref.kind);
}

/** Whether `group` is the one the built-in `kind` is served in. */
export function isBuiltInGroup(kind: string, group: string): boolean {
  const known = isResourceType(kind) ? toKind(kind) : null;
  const builtIn = known ? getResourceDefinition(known) : accessKind(kind);
  return builtIn?.group === group;
}

/**
 * Where one object opens, or `null` when it cannot be addressed: a kind
 * nothing knows the plural of, or a namespaced kind handed no namespace.
 */
export function objectLink(
  ref: ObjectRef,
  options: ObjectLinkOptions = {}
): AppLink | null {
  if (ref.crd === null) return null;
  const access = accessOf(ref);
  const crd = crdFor(ref);
  const resource = resourceSegment({ kind: ref.kind, crd });
  if (!resource) return null;
  const { tab, via, view } = options;
  const search =
    tab || via || view
      ? Object.fromEntries(
          Object.entries({ tab, via, view }).filter(([, value]) => value)
        )
      : undefined;
  const clusterScoped = access
    ? !access.namespaced
    : !crd && isClusterScoped(ref.kind);
  if (!clusterScoped && ref.namespace) {
    return {
      to: "/c/$cluster/$resource/$namespace/$name",
      params: inCluster(
        { resource, namespace: ref.namespace, name: ref.name },
        options.cluster
      ),
      search,
    } as AppLink;
  }
  if (!clusterScoped && (!crd || access)) return null;
  return {
    to: "/c/$cluster/$resource/$name",
    params: inCluster({ resource, name: ref.name }, options.cluster),
    search,
  } as AppLink;
}

/** The page that lists this kind. */
export function listLink(
  kind: string,
  search?: Record<string, string>
): AppLink {
  const elsewhere = listedElsewhere(kind);
  return {
    to: "/c/$cluster/$resource",
    params: inCluster({ resource: listSegment(kind) }),
    search: elsewhere ? { ...search, listOf: toPlural(elsewhere) } : search,
  } as AppLink;
}

/**
 * The list of a kind the catalogue names: its own page where the registry
 * holds that very kind, the generic list of whatever is served otherwise.
 */
export function servedListLink(kind: ServedKindRef): AppLink {
  const known = registryKindOf(kind);
  return known ? listLink(known) : resourceListLink(segmentOf(kind));
}

/** Where one object of a served kind opens, by the same rule as its list. */
export function servedObjectLink(
  ref: ServedKindRef & { name: string; namespace?: string | null },
  options?: ObjectLinkOptions
): AppLink | null {
  return objectLink(
    {
      kind: ref.kind,
      name: ref.name,
      namespace: ref.namespace,
      crd: segmentOf(ref),
    },
    options
  );
}

interface ServedKindRef {
  kind: string;
  group: string;
  plural: string;
}

/** The registry's kind only where it is that very kind, not a namesake in another group. */
function registryKindOf(kind: ServedKindRef): ResourceKind | null {
  const known = isResourceType(kind.kind) ? toKind(kind.kind) : null;
  const definition = known ? getResourceDefinition(known) : null;
  return known &&
    definition?.group === kind.group &&
    definition.plural === kind.plural
    ? known
    : null;
}

/**
 * The Pods list narrowed to a label selector, read in these namespaces
 * (`null` for every one): the pods a NetworkPolicy, or one of its peers,
 * is about.
 */
export function selectedPodsLink(
  selector: string,
  namespaces: readonly string[] | null
): AppLink {
  const search: Record<string, string> = {};
  if (selector !== "") search.selector = selector;
  if (namespaces) search.in = [...namespaces].sort().join(",");
  return listLink("Pod", search);
}

/** The list of any served kind, by the segment its address carries. */
export function resourceListLink(
  resource: string,
  search?: Record<string, string>
): AppLink {
  return {
    to: "/c/$cluster/$resource",
    params: inCluster({ resource }),
    search,
  } as AppLink;
}

/** That list with the window scoped to one namespace on arrival. */
export function namespaceListLink(
  resource: string,
  namespace: string
): AppLink {
  return resourceListLink(resource, { namespace });
}

/** The objects one CRD defines: its own page, on the instances tab. */
export function crdInstancesLink(crd: string): AppLink {
  return objectLink(
    { kind: "CustomResourceDefinition", name: crd },
    { tab: "instances" }
  )!;
}

export function clusterLink(cluster?: string): AppLink {
  return { to: "/c/$cluster", params: inCluster({}, cluster) } as AppLink;
}

export function pageLink(
  page:
    | "events"
    | "changes"
    | "integrations"
    | "routes"
    | "helm"
    | "api-resources"
    | "my-access",
  search?: Record<string, string>,
  cluster?: string
): AppLink {
  return {
    to: "/c/$cluster/$resource",
    params: inCluster({ resource: page }, cluster),
    search,
  } as AppLink;
}

export function vendorLink(
  vendor: string,
  search?: Record<string, string>
): AppLink {
  return {
    to: "/c/$cluster/integrations/$vendor",
    params: inCluster({ vendor }),
    search,
  } as AppLink;
}

export function helmReleaseLink(release: {
  source: string;
  namespace: string;
  name: string;
}): AppLink {
  return {
    to: "/c/$cluster/helm/$source/$namespace/$name",
    params: inCluster({ ...release }),
  } as AppLink;
}

let router: AnyRouter | null = null;

export function setRouter(next: AnyRouter): void {
  router = next;
}

/** The address a link resolves to from where the window is now. */
export function hrefOf(link: AppLink): string {
  if (!router) throw new Error("hrefOf called before the router exists");
  return router.buildLocation(link as Parameters<AnyRouter["buildLocation"]>[0])
    .href;
}

/** The cluster an in-app address is in, or `null` outside one. */
export function clusterOf(pathname: string): string | null {
  const [first, second] = pathname.split("/").filter(Boolean);
  if (first !== "c" || !second) return null;
  try {
    return decodeURIComponent(second);
  } catch {
    return null;
  }
}

/**
 * The namespace an address shows one object in, and `null` where it shows a
 * list, a page or a cluster-scoped object. A Namespace's own page is in it.
 */
export function namespaceShownBy(href: string): string | null {
  const [path] = href.split("?");
  const [c, cluster, resource, ...rest] = path.split("/").filter(Boolean);
  if (c !== "c" || !cluster) return null;
  const segment =
    resource === "namespaces" && rest.length === 1
      ? rest[0]
      : resource === "helm"
        ? rest.length === 3
          ? rest[1]
          : undefined
        : rest.length === 2
          ? rest[0]
          : undefined;
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * The same place in another cluster: a list stays a list, and an object,
 * which exists in the cluster it was opened in and nowhere else, gives way
 * to its kind's list.
 */
export function retargetHref(href: string, cluster: string): string {
  const [path] = href.split("?");
  const parts = path.split("/").filter(Boolean);
  const base = `/c/${encodeURIComponent(cluster)}`;
  if (parts[0] !== "c" || parts.length < 3) return base;
  const [, , resource, ...rest] = parts;
  if (rest.length === 0) return `${base}/${resource}`;
  if (resource === "integrations") return `${base}/integrations`;
  return `${base}/${listSegment(resource)}`;
}
