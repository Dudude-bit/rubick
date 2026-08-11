/**
 * What the ingress-nginx page reads, and what it costs.
 *
 * Less than Traefik's page, because nginx owns no custom resources: the
 * routing table is `list_ingresses` plus the IngressClasses, both of which
 * the app already lists elsewhere. Services and their endpoints come through
 * the shared query every routing page uses, so a reader who has just looked
 * at Traefik's page pays nothing for them here.
 *
 * The one read that is nginx's own is the controller's manifest, and it is
 * the only way to answer a question nothing in the API server does: **which
 * ConfigMap is the global one.** It is named in a `--configmap` flag, and
 * the name in that flag is not even literal — the static manifest ships
 * `--configmap=$(POD_NAMESPACE)/ingress-nginx-controller`, expanded by the
 * kubelet from the container's own environment.
 */

import { useQueries, useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import type {
  IngressClassSummary,
  IngressInfo,
  TlsCertificate,
} from "@/generated/types";
import {
  expandEnv,
  ROUTING_STALE,
  useBackingLists,
  workloadArgs,
  workloadEnv,
  type BackingLists,
} from "../ingress";
import { allRoutes, type NginxRoute, type NginxSources } from "./model";

/** The label every ingress-nginx release puts on its own workload. */
const CONTROLLER_SELECTOR = "app.kubernetes.io/name=ingress-nginx";

export interface RouteSources {
  ingresses: IngressInfo[];
  classes: IngressClassSummary[];
}

export async function fetchRouteSources(): Promise<RouteSources> {
  const [ingresses, binding] = await Promise.all([
    commands.listIngresses(null),
    commands.resolveIngressClass(null),
  ]);
  return { ingresses, classes: binding.available };
}

/**
 * How many hosts this nginx serves — the sidebar's number.
 *
 * Hosts, not Ingresses: two Ingresses claiming one host are one row on the
 * page, and a canary pair is emphatically one. A count of objects over a
 * page pivoted by host would disagree with the page it links to.
 */
export function countHosts(sources: RouteSources): number {
  const hosts = new Set(
    allRoutes({ ...sources, services: [], published: [] }).map(
      (route) => route.host ?? ""
    )
  );
  return hosts.size;
}

export const ROUTE_SOURCES_KEY = ["ingress-nginx", "route-sources"] as const;

export function useRouteSources() {
  return useQuery({
    queryKey: ROUTE_SOURCES_KEY,
    queryFn: fetchRouteSources,
    staleTime: ROUTING_STALE,
  });
}

export const useBacking = useBackingLists;

/** Where the global ConfigMap lives, and what is in it. */
export interface GlobalConfig {
  namespace: string;
  name: string;
  data: Record<string, string>;
  /** Why there is nothing above, in words rather than an empty object. */
  problem: string | null;
}

export interface ControllerInfo {
  workload: {
    name: string;
    namespace: string;
    image: string | null;
    ready: number;
    desired: number;
  } | null;
  args: string[];
  /** The class names this controller was told to answer for, from its flags. */
  watching: { controllerClass: string | null; ingressClass: string | null };
  config: GlobalConfig | null;
  problem: string | null;
}

/** `--configmap=ns/name`, `--configmap ns/name`, either spelling. */
function flagValue(args: string[], flag: string): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith(`--${flag}=`)) return arg.slice(flag.length + 3);
    if (arg === `--${flag}`) return args[index + 1] ?? null;
  }
  return null;
}

async function fetchController(): Promise<ControllerInfo> {
  const none = (problem: string): ControllerInfo => ({
    workload: null,
    args: [],
    watching: { controllerClass: null, ingressClass: null },
    config: null,
    problem,
  });

  const deployments = await commands
    .listDeployments({
      namespace: null,
      labelSelector: CONTROLLER_SELECTOR,
      fieldSelector: null,
      limit: null,
    })
    .catch(() => []);

  const deployment = deployments[0];
  if (!deployment) {
    return none(
      `Nothing in this cluster carries ${CONTROLLER_SELECTOR}, so the controller's own configuration could not be read — including which ConfigMap is the global one.`
    );
  }

  const workload = {
    name: deployment.name,
    namespace: deployment.namespace,
    image: deployment.containers[0]?.image ?? null,
    ready: deployment.replicas.ready,
    desired: deployment.replicas.desired,
  };

  let manifest: string;
  try {
    manifest = await commands.getManifest(
      "Deployment",
      "apps/v1",
      workload.name,
      workload.namespace
    );
  } catch (error) {
    return {
      workload,
      args: [],
      watching: { controllerClass: null, ingressClass: null },
      config: null,
      problem: `Its manifest could not be read, so the global ConfigMap it uses is unknown — ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const args = workloadArgs(manifest);
  const env = workloadEnv(manifest);
  const watching = {
    controllerClass: flagValue(args, "controller-class"),
    ingressClass: flagValue(args, "ingress-class"),
  };

  const named = flagValue(args, "configmap");
  if (!named) {
    return {
      workload,
      args,
      watching,
      config: null,
      problem:
        "This controller was started with no --configmap flag, so it has no global ConfigMap and every setting comes from its own defaults or from an Ingress.",
    };
  }

  // `$(POD_NAMESPACE)` is what the flag literally says in the shipped
  // manifest. The kubelet expands it from the downward API; nothing here
  // can read the running pod's environment, so the workload's own namespace
  // is the fallback — which is what that variable resolves to anyway.
  const expanded = expandEnv(named, env, {
    POD_NAMESPACE: workload.namespace,
  });
  const [namespace, name] = expanded.includes("/")
    ? expanded.split("/", 2)
    : [workload.namespace, expanded];

  try {
    const data = await commands.getConfigmapData(name, namespace);
    return {
      workload,
      args,
      watching,
      config: { namespace, name, data: data.values, problem: null },
      problem: null,
    };
  } catch (error) {
    return {
      workload,
      args,
      watching,
      config: {
        namespace,
        name,
        data: {},
        problem: `The controller reads ${namespace}/${name}, and it could not be read here — ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
      problem: null,
    };
  }
}

export function useController() {
  return useQuery({
    queryKey: ["ingress-nginx", "controller"],
    queryFn: fetchController,
    staleTime: ROUTING_STALE,
  });
}

/** The certificates behind the TLS Secrets these routes are served under. */
export function useRouteCertificates(routes: NginxRoute[] | undefined) {
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
      queryKey: ["tls-certificates", batch.namespace, batch.names.join(",")],
      queryFn: () => commands.getTlsCertificates(batch.namespace, batch.names),
      staleTime: ROUTING_STALE,
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

export function sourcesFrom(
  routeSources: RouteSources,
  backing: BackingLists | undefined,
  certificates: Map<string, TlsCertificate>
): NginxSources {
  return {
    ...routeSources,
    services: backing?.services ?? [],
    published: backing?.published ?? [],
    backingKnown: backing !== undefined,
    certificates,
  };
}
