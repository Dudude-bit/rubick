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
import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import { useClusterStore } from "@/stores/clusterStore";
import type {
  CustomResourceInfo,
  IngressClassSummary,
  IngressInfo,
  TlsCertificate,
} from "@/generated/types";
import {
  BACKING_NOT_READ,
  useBackingLists,
  type BackingLists,
  controllerContainers,
  workloadArgs,
  type BackingSources,
  findControllerWorkload,
  type ControllerWorkload,
} from "../ingress";
import {
  allRoutes,
  readEntryPoints,
  type EntryPoint,
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
 * The API group each cluster answers for, remembered by context.
 *
 * A cluster does not migrate from v2 to v3 while the app is open, and the
 * fallback costs a failed request every time it is not remembered. The app
 * does move between clusters, and the next one may be on the other group.
 */
const servedGroups = new Map<string, string>();

const contextNow = () => useClusterStore.getState().currentContext ?? "";

export async function listTraefik(
  kindPlural: string
): Promise<CustomResourceInfo[]> {
  const context = contextNow();
  const served = servedGroups.get(context);
  if (served) {
    return commands.listCustomResources(
      `${kindPlural}.${served}`,
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
    servedGroups.set(context, GROUPS[0]);
    return objects;
  } catch (error) {
    try {
      const objects = await commands.listCustomResources(
        `${kindPlural}.${GROUPS[1]}`,
        null,
        null,
        null
      );
      servedGroups.set(context, GROUPS[1]);
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
  return servedGroups.get(contextNow()) ?? GROUPS[0];
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
      ...BACKING_NOT_READ,
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
  workload: ControllerWorkload | null;
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

  const { workload, unread } =
    await findControllerWorkload(CONTROLLER_SELECTOR);
  if (!workload) {
    return none(
      unread ?? {
        key: "traefikNoController",
        values: { selector: CONTROLLER_SELECTOR },
      }
    );
  }

  let args: string[];
  try {
    args = workloadArgs(await controllerContainers(workload));
  } catch (error) {
    return {
      workload,
      args: [],
      entryPoints: [],
      problem: {
        key: "traefikManifestUnreadable",
        values: {
          why: errorToShow(error),
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

/** Everything the page needs, once all three queries have answered. */
export function sourcesFrom(
  routeSources: RouteSources,
  backing: BackingSources,
  controller: ControllerInfo | undefined,
  certificates: Map<string, TlsCertificate>
): TraefikSources {
  return {
    ...routeSources,
    ...backing,
    entryPoints: controller?.entryPoints ?? [],
    certificates,
  };
}
