import type { AnyRouter, LinkOptions } from "@tanstack/react-router";

import {
  getResourceDefinition,
  isResourceType,
  listSegment,
  toKind,
  toPlural,
  type ResourceKind,
} from "./resource-registry";

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
  /** `<plural>.<group>` for a custom resource, which the registry cannot spell. */
  crd?: string;
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

/**
 * Where one object opens, or `null` when it cannot be addressed: a kind
 * nothing knows the plural of, or a namespaced kind handed no namespace.
 */
export function objectLink(
  ref: ObjectRef,
  options: { tab?: string; cluster?: string } = {}
): AppLink | null {
  const resource = resourceSegment(ref);
  if (!resource) return null;
  const search = options.tab ? { tab: options.tab } : undefined;
  const clusterScoped = !ref.crd && isClusterScoped(ref.kind);
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
  if (!clusterScoped && !ref.crd) return null;
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
  return {
    to: "/c/$cluster/$resource",
    params: inCluster({ resource: listSegment(kind) }),
    search,
  } as AppLink;
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
  page: "events" | "changes" | "integrations" | "routes" | "helm",
  search?: Record<string, string>
): AppLink {
  return {
    to: "/c/$cluster/$resource",
    params: inCluster({ resource: page }),
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
