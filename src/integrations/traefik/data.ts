/**
 * What the Traefik page reads, and what it costs.
 *
 * Five cluster-wide list calls and, once, the controller's own manifest. It
 * is deliberately not paged: "what hosts does this cluster serve" is a
 * question about the whole cluster, and a page that answered it for the first
 * fifty would answer it wrongly. What keeps that affordable is that all of it
 * is *cluster* data the app already lists elsewhere — the Ingress list page
 * makes the same `list_ingresses` call — and that none of it is fetched until
 * the reader opens the page.
 *
 * The reads are split into three queries rather than one, because they are
 * needed at three different moments. The routes alone answer the sidebar's
 * count and draw every host row; services and endpoints are only needed to
 * say what is *behind* a route; and the controller's manifest is only needed
 * by two of the four tabs.
 */

import type { Saying } from "@/i18n/say";
import { useQueries, useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import type {
  CustomResourceInfo,
  IngressClassSummary,
  IngressInfo,
  TlsCertificate,
} from "@/generated/types";
import { useBackingLists, workloadArgs, type BackingLists } from "../ingress";
import {
  allRoutes,
  readEntryPoints,
  type EntryPoint,
  type TraefikRoute,
  type TraefikSources,
} from "./model";

/**
 * `traefik.containo.us` is the whole of what a cluster still on v2 serves, so
 * asking for the v3 group there fails rather than returning nothing. The
 * rename is vendor knowledge and this is the only place it is handled.
 */
export const GROUPS: readonly string[] = ["traefik.io", "traefik.containo.us"];

/** The label every Traefik chart puts on its own workload. */
const CONTROLLER_SELECTOR = "app.kubernetes.io/name=traefik";

/**
 * The API group this cluster answers for, remembered for the session.
 *
 * A cluster does not migrate from v2 to v3 while the app is open, and the
 * fallback costs a failed request every time it is not remembered.
 */
let servedGroup: string | null = null;

export async function listTraefik(
  kindPlural: string
): Promise<CustomResourceInfo[]> {
  if (servedGroup) {
    return commands.listCustomResources(
      `${kindPlural}.${servedGroup}`,
      null,
      null,
      null
    );
  }
  try {
    const objects = await commands.listCustomResources(
      `${kindPlural}.${GROUPS[0]}`,
      null,
      null,
      null
    );
    servedGroup = GROUPS[0];
    return objects;
  } catch (error) {
    try {
      const objects = await commands.listCustomResources(
        `${kindPlural}.${GROUPS[1]}`,
        null,
        null,
        null
      );
      servedGroup = GROUPS[1];
      return objects;
    } catch {
      // Only the group rename is recovered from. If the fallback fails too
      // the page says it could not read them, which is the honest answer and
      // not an empty routing table.
      throw error;
    }
  }
}

/** The group this cluster answered on, once anything has been read. */
export function servedGroupName(): string {
  return servedGroup ?? GROUPS[0];
}

export interface RouteSources {
  ingresses: IngressInfo[];
  ingressRoutes: CustomResourceInfo[];
  middlewares: CustomResourceInfo[];
  classes: IngressClassSummary[];
}

export const ROUTE_SOURCES = ["traefik", "route-sources"] as const;
const CONTROLLER = ["traefik", "controller"];

/** A minute: routing changes with a deploy, not by the second. */
export const ROUTE_STALE = 60_000;

export async function fetchRouteSources(): Promise<RouteSources> {
  const [ingresses, ingressRoutes, middlewares, binding] = await Promise.all([
    commands.listIngresses(null),
    listTraefik("ingressroutes"),
    listTraefik("middlewares"),
    commands.resolveIngressClass(null),
  ]);
  return { ingresses, ingressRoutes, middlewares, classes: binding.available };
}

/**
 * How many hosts this Traefik serves — the sidebar's number, from the page's
 * own answer. Hosts rather than IngressRoutes: Traefik on a k3d cluster serves
 * plain Ingresses and may own no IngressRoute at all, and a row reading `0`
 * over a page with twelve hosts on it would be a lie about an empty page.
 */
export function countHosts(sources: RouteSources): number {
  const hosts = new Set(
    allRoutes({
      ...sources,
      services: [],
      published: [],
      entryPoints: [],
    }).map((route) => route.clause.host ?? "")
  );
  return hosts.size;
}

export function useRouteSources() {
  const context = useClusterStore((state) => state.currentContext);
  return useQuery({
    queryKey: [context, ...ROUTE_SOURCES],
    queryFn: fetchRouteSources,
    staleTime: ROUTE_STALE,
  });
}

/**
 * What each Service publishes, from its own EndpointSlices. The same answer
 * the traffic chain is built on — and the same query key every other
 * routing page uses, because the lists do not differ by who asked.
 */
export const useBacking = useBackingLists;

export type Backing = BackingLists;

export interface ControllerInfo {
  workload: {
    kind: "Deployment" | "DaemonSet";
    name: string;
    namespace: string;
    image: string | null;
    ready: number;
    desired: number;
  } | null;
  args: string[];
  entryPoints: EntryPoint[];
  /** Why there is nothing above, in words rather than an empty object. */
  problem: Saying | null;
}

/**
 * The proxy itself.
 *
 * Entry points are *static* configuration: they exist only in the flags the
 * process was started with, and nothing in the API server knows about them.
 * That is why this reads the workload's manifest rather than a status field,
 * and why "what does this listen on" is a question no other screen in this
 * app can answer.
 */
export async function fetchController(): Promise<ControllerInfo> {
  const none = (problem: Saying): ControllerInfo => ({
    workload: null,
    args: [],
    entryPoints: [],
    problem,
  });

  const filters = {
    namespace: null,
    labelSelector: CONTROLLER_SELECTOR,
    fieldSelector: null,
    limit: null,
  };

  const [deployments, daemonSets] = await Promise.all([
    commands.listDeployments(filters).catch(() => []),
    commands.listDaemonsets(filters).catch(() => []),
  ]);

  const deployment = deployments[0];
  const daemonSet = daemonSets[0];
  if (!deployment && !daemonSet) {
    return none({
      key: "traefikNoController",
      values: { selector: CONTROLLER_SELECTOR },
    });
  }

  const workload = deployment
    ? {
        kind: "Deployment" as const,
        name: deployment.name,
        namespace: deployment.namespace,
        image: deployment.containers[0]?.image ?? null,
        ready: deployment.replicas.ready,
        desired: deployment.replicas.desired,
      }
    : {
        kind: "DaemonSet" as const,
        name: daemonSet.name,
        namespace: daemonSet.namespace,
        image: null,
        ready: daemonSet.ready,
        desired: daemonSet.desired,
      };

  let args: string[];
  try {
    const manifest = await commands.getManifest(
      workload.kind,
      "apps/v1",
      workload.name,
      workload.namespace
    );
    args = workloadArgs(manifest);
  } catch (error) {
    return {
      workload,
      args: [],
      entryPoints: [],
      problem: {
        key: "traefikManifestUnreadable",
        values: {
          why: error instanceof Error ? error.message : String(error),
        },
      },
    };
  }

  return {
    workload,
    args,
    entryPoints: readEntryPoints(args),
    problem: args.length === 0 ? { key: "traefikNoArgs" } : null,
  };
}

export function useController() {
  const context = useClusterStore((state) => state.currentContext);
  return useQuery({
    queryKey: [context, ...CONTROLLER],
    queryFn: fetchController,
    staleTime: ROUTE_STALE,
  });
}

/**
 * The certificates behind the TLS Secrets these routes are served under.
 *
 * Core, and it works on a cluster with nothing installed: `tls.crt` states
 * its own validity. cert-manager's half — *why* it looks like that, and what
 * is stopping the renewal — arrives separately through the capability seam
 * and is simply absent when nothing supplies it.
 */
export function useRouteCertificates(routes: TraefikRoute[] | undefined) {
  const context = useClusterStore((state) => state.currentContext);
  const byNamespace = new Map<string, string[]>();
  for (const route of routes ?? []) {
    if (!route.tlsSecret) continue;
    const namespace = route.source.namespace;
    const names = byNamespace.get(namespace) ?? [];
    if (!names.includes(route.tlsSecret)) names.push(route.tlsSecret);
    byNamespace.set(namespace, names);
  }
  const batches = [...byNamespace.entries()].map(([namespace, names]) => ({
    namespace,
    names: [...names].sort(),
  }));

  const results = useQueries({
    queries: batches.map((batch) => ({
      queryKey: [
        context,
        "tls-certificates",
        batch.namespace,
        batch.names.join(","),
      ],
      queryFn: () => commands.getTlsCertificates(batch.namespace, batch.names),
      staleTime: ROUTE_STALE,
    })),
  });

  const certificates = new Map<string, TlsCertificate>();
  results.forEach((result, index) => {
    for (const read of result.data ?? []) {
      certificates.set(`${batches[index].namespace}/${read.secretName}`, read);
    }
  });
  return certificates;
}

/** Everything the page needs, once all three queries have answered. */
export function sourcesFrom(
  routeSources: RouteSources,
  backing: Backing | undefined,
  controller: ControllerInfo | undefined,
  certificates: Map<string, TlsCertificate>
): TraefikSources {
  return {
    ...routeSources,
    services: backing?.services ?? [],
    published: backing?.published ?? [],
    backingKnown: backing !== undefined,
    entryPoints: controller?.entryPoints ?? [],
    certificates,
  };
}
