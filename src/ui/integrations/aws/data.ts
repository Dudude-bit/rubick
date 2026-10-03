/**
 * What the AWS Load Balancer Controller's page reads.
 *
 * The one read nothing in the app made before is the second line of the join:
 * `IngressClass.spec.parameters` names an `IngressClassParams`, and
 * `IngressClassBinding` — what `resolve_ingress_class` answered with — carried
 * a name, a controller and a default flag and nothing else. So the scheme,
 * the certificate, the WAF ACL and the subnets of every ALB in the cluster
 * sat in an object the app listed as an anonymous custom resource, joined to
 * nothing.
 *
 * `resolve_ingress_class` carries each class's `spec.parameters` now, so
 * the join needs no read of its own.
 */

import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { ERROR_CODES, errorCode, errorToShow } from "@/lib/error-utils";
import { useClusterStore } from "@/stores/clusterStore";
import type {
  CustomResourceInfo,
  IngressClassSummary,
  IngressInfo,
} from "@/generated/types";
import { ROUTING_STALE } from "../ingress";
import { INGRESS_CLASS_PARAMS_CRD, TARGET_GROUP_BINDING_CRD } from "./model";

/** What this controller writes into an IngressClass's `spec.controller`. */
export const CONTROLLER = "ingress.k8s.aws/alb";

export interface AlbSources {
  ingresses: IngressInfo[];
  params: CustomResourceInfo[];
  bindings: CustomResourceInfo[];
  /** Class name to the `IngressClassParams` its `spec.parameters` names. */
  classParams: Map<string, string>;
  ownClasses: string[];
  /** Kinds that could not be listed, so no absence below is stated blind. */
  unread: Array<{ crd: string; reason: string }>;
}

const listKind = async (
  crd: string,
  unread: AlbSources["unread"]
): Promise<CustomResourceInfo[]> => {
  try {
    return await commands.listCustomResources(crd, null, null, null);
  } catch (error) {
    // A kind the API server does not serve holds none; a name into it is
    // truly absent. Anything else is a list nobody read.
    if (errorCode(error) !== ERROR_CODES.NOT_FOUND) {
      unread.push({
        crd,
        reason: errorToShow(error),
      });
    }
    return [];
  }
};

/**
 * The `IngressClassParams` a class names. Only this controller's own kind:
 * an IngressClass may point its parameters at anything, and reading somebody
 * else's object as an `IngressClassParams` would invent fields it never had.
 */
export function parametersOf(entry: IngressClassSummary): string | null {
  const parameters = entry.parameters;
  if (!parameters) return null;
  return parameters.kind === "IngressClassParams" ? parameters.name : null;
}

export async function fetchAlbSources(): Promise<AlbSources> {
  const unread: AlbSources["unread"] = [];
  const [ingresses, binding, params, bindings] = await Promise.all([
    commands.listIngresses(null),
    commands.resolveIngressClass(null),
    listKind(INGRESS_CLASS_PARAMS_CRD, unread),
    listKind(TARGET_GROUP_BINDING_CRD, unread),
  ]);

  const own = binding.available.filter(
    (entry) => entry.controller === CONTROLLER
  );
  const ownClasses = own.map((entry) => entry.name);

  return {
    ingresses,
    params,
    bindings,
    classParams: new Map(
      own.flatMap((entry) => {
        const parameters = parametersOf(entry);
        return parameters ? [[entry.name, parameters] as const] : [];
      })
    ),
    ownClasses,
    unread,
  };
}

export const ALB_SOURCES_KEY = ["aws-lbc", "sources"] as const;

export function useAlbSources() {
  const context = useClusterStore((state) => state.currentContext);
  return useQuery({
    queryKey: [context, ...ALB_SOURCES_KEY],
    queryFn: fetchAlbSources,
    staleTime: ROUTING_STALE,
  });
}
