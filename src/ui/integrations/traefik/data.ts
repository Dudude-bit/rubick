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
import { ERROR_CODES, errorCode, errorToShow } from "@/lib/error-utils";
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
  controllerClients,
  type ControllerWorkload,
} from "../ingress";
import {
  allRoutes,
  CONTROLLER as TRAEFIK_CONTROLLER,
  GATEWAY_CONTROLLER,
  readEmptyServices,
  readEntryPoints,
  type EmptyServices,
  type EntryPoint,
  type TraefikSources,
} from "./model";

/**
 * Traefik 2.10 and 2.11 serve their kinds under both groups and read both;
 * v3 reads `traefik.io` alone, 2.9 and older `traefik.containo.us` alone.
 * The rename is vendor knowledge and this is the only place it is handled.
 */
export const GROUPS: readonly string[] = ["traefik.io", "traefik.containo.us"];

/** The label every Traefik chart puts on its own workload. */
const CONTROLLER_SELECTOR = "app.kubernetes.io/name=traefik";

export const ingressClients = (controller: string) =>
  controller === TRAEFIK_CONTROLLER || controller === GATEWAY_CONTROLLER
    ? controllerClients("Traefik", CONTROLLER_SELECTOR)
    : null;

/** The groups the Traefik of this image reads; `null` where its tag is not a version. */
export function groupsReadBy(image: string | null): readonly string[] | null {
  const tag = image?.split("@")[0].split("/").pop()?.split(":")[1];
  const version = tag?.match(/^v?(\d{1,2})\.(\d+)/);
  if (!version) return null;
  const major = Number(version[1]);
  if (major >= 3) return [GROUPS[0]];
  if (major < 2) return null;
  return Number(version[2]) >= 10 ? GROUPS : [GROUPS[1]];
}

interface GroupRead {
  group: string;
  objects: CustomResourceInfo[];
  /** Why this group's list did not come back; `objects` is then not its answer. */
  failed?: unknown;
}

/**
 * One kind in every group that serves it. A group the cluster does not serve
 * is left out, by the error's code; one that could not be read is carried,
 * because whether that matters depends on which groups this Traefik reads.
 */
async function readGroups(kindPlural: string): Promise<GroupRead[]> {
  const answers = await Promise.allSettled(
    GROUPS.map((group) =>
      commands.listCustomResources(`${kindPlural}.${group}`, null, null, null)
    )
  );
  const reads = answers.flatMap((answer, at): GroupRead[] => {
    if (answer.status === "fulfilled") {
      return [{ group: GROUPS[at], objects: answer.value }];
    }
    return errorCode(answer.reason) === ERROR_CODES.NOT_FOUND
      ? []
      : [{ group: GROUPS[at], objects: [], failed: answer.reason }];
  });
  if (reads.length === 0) throw (answers[0] as PromiseRejectedResult).reason;
  return reads;
}

/**
 * What this Traefik reads of one kind. A group it reads that failed is the
 * whole read failing, never fewer objects. Under both groups one name is one
 * object to Traefik, the `traefik.io` one, so the other is dropped as it is
 * there.
 */
function settle(
  reads: GroupRead[],
  reading: readonly string[] | null
): CustomResourceInfo[] {
  const counted = reads.filter(
    (read) => !reading || reading.includes(read.group)
  );
  const failed = counted.find((read) => read.failed !== undefined);
  if (failed) throw failed.failed;
  const kept = new Map<string, CustomResourceInfo>();
  for (const object of counted.flatMap((read) => read.objects)) {
    const key = `${object.namespace ?? ""}/${object.name}`;
    if (!kept.has(key)) kept.set(key, object);
  }
  return [...kept.values()];
}

const isLegacy = (object: CustomResourceInfo) =>
  !object.apiVersion.startsWith(`${GROUPS[0]}/`);

export interface RouteSources {
  ingresses: IngressInfo[];
  ingressRoutes: CustomResourceInfo[];
  middlewares: CustomResourceInfo[];
  classes: IngressClassSummary[];
  /**
   * IngressRoutes above kept under `traefik.containo.us` on a cluster serving
   * both groups, where the proxy's version, and so whether it reads them,
   * could not be told. Zero where that is known or there are none.
   */
  legacyUnconfirmed: number;
}

export const ROUTE_SOURCES = ["traefik", "route-sources"] as const;
const CONTROLLER = ["traefik", "controller"];

/** A minute: routing changes with a deploy, not by the second. */
export const ROUTE_STALE = 60_000;

export async function fetchRouteSources(): Promise<RouteSources> {
  const [ingresses, routeReads, middlewareReads, binding] = await Promise.all([
    commands.listIngresses(null),
    readGroups("ingressroutes"),
    readGroups("middlewares"),
    commands.resolveIngressClass(null),
  ]);
  const reads = [...routeReads, ...middlewareReads];
  // The proxy's version changes the answer only where both groups are served
  // and the second one failed or holds something; elsewhere it is not asked.
  const versionDecides =
    new Set(reads.map((read) => read.group)).size > 1 &&
    reads.some(
      (read) =>
        read.failed !== undefined ||
        (read.group !== GROUPS[0] && read.objects.length > 0)
    );
  const reading = versionDecides
    ? groupsReadBy(
        (await findControllerWorkload(CONTROLLER_SELECTOR)).workload?.image ??
          null
      )
    : null;
  const ingressRoutes = settle(routeReads, reading);
  return {
    ingresses,
    ingressRoutes,
    middlewares: settle(middlewareReads, reading),
    classes: binding.available,
    legacyUnconfirmed:
      versionDecides && reading === null
        ? ingressRoutes.filter(isLegacy).length
        : 0,
  };
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
  emptyServices: EmptyServices | null;
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
    emptyServices: null,
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
      emptyServices: null,
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
    emptyServices: readEmptyServices(args),
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
    emptyServices: controller?.emptyServices ?? undefined,
    certificates,
  };
}
