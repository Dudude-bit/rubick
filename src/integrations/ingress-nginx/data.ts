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

import type { Saying } from "@/i18n/say";
import type { T } from "@/i18n/useT";
import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import type {
  IngressClassSummary,
  IngressInfo,
  TlsCertificate,
} from "@/generated/types";
import {
  BACKING_NOT_READ,
  expandEnv,
  ROUTING_STALE,
  useBackingLists,
  workloadArgs,
  workloadEnv,
  type BackingSources,
  findControllerWorkload,
  type ControllerWorkload,
} from "../ingress";
import { allRoutes, type NginxSources } from "./model";

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
  // The count reads `route.host` and nothing else, so it cannot depend on
  // the language — and threading a translator in so that a number could
  // ignore it would be a parameter that exists to be discarded.
  const noWords: T = () => "";
  const hosts = new Set(
    allRoutes({ ...sources, ...BACKING_NOT_READ }, noWords).map(
      (route) => route.host ?? ""
    )
  );
  return hosts.size;
}

export const ROUTE_SOURCES_KEY = ["ingress-nginx", "route-sources"] as const;

export function useRouteSources() {
  const context = useClusterStore((state) => state.currentContext);
  return useQuery({
    queryKey: [context, ...ROUTE_SOURCES_KEY],
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
  problem: Saying | null;
}

export interface ControllerInfo {
  workload: ControllerWorkload | null;
  args: string[];
  /** The class names this controller was told to answer for, from its flags. */
  watching: { controllerClass: string | null; ingressClass: string | null };
  config: GlobalConfig | null;
  problem: Saying | null;
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

export async function fetchController(): Promise<ControllerInfo> {
  const none = (problem: Saying): ControllerInfo => ({
    workload: null,
    args: [],
    watching: { controllerClass: null, ingressClass: null },
    config: null,
    problem,
  });

  const { workload, refused } =
    await findControllerWorkload(CONTROLLER_SELECTOR);
  if (!workload) {
    return none(
      refused
        ? { key: "controllerUnread", values: { why: refused } }
        : {
            key: "nginxNoController",
            values: { selector: CONTROLLER_SELECTOR },
          }
    );
  }

  let manifest: string;
  try {
    manifest = await commands.getManifest(
      workload.kind,
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
      problem: {
        key: "nginxManifestUnreadable",
        values: {
          why: error instanceof Error ? error.message : String(error),
        },
      },
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
      problem: { key: "nginxNoConfigMapFlag" },
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
        problem: {
          key: "nginxConfigMapUnreadable",
          values: {
            where: `${namespace}/${name}`,
            why: error instanceof Error ? error.message : String(error),
          },
        },
      },
      problem: null,
    };
  }
}

export function useController() {
  const context = useClusterStore((state) => state.currentContext);
  return useQuery({
    queryKey: [context, "ingress-nginx", "controller"],
    queryFn: fetchController,
    staleTime: ROUTING_STALE,
  });
}

export function sourcesFrom(
  routeSources: RouteSources,
  backing: BackingSources,
  certificates: Map<string, TlsCertificate>
): NginxSources {
  return { ...routeSources, ...backing, certificates };
}
