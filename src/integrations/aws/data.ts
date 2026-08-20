/**
 * What the AWS Load Balancer Controller's page reads.
 *
 * The one read nothing in the app made before is the second line of the join:
 * `IngressClass.spec.parameters` names an `IngressClassParams`, and
 * `IngressClassBinding` — what `resolve_ingress_class` answers with — carries
 * a name, a controller and a default flag and nothing else. So the scheme,
 * the certificate, the WAF ACL and the subnets of every ALB in the cluster
 * sat in an object the app listed as an anonymous custom resource, joined to
 * nothing.
 *
 * There is no `get_ingress_class` command, and the parameters reference is
 * not in any generated type, so the manifest is read and the one field taken
 * out of it. One `get` per class whose controller is this one, which on any
 * real cluster is one or two.
 */

import { useQuery } from "@tanstack/react-query";
import { load } from "js-yaml";

import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import type { CustomResourceInfo, IngressInfo } from "@/generated/types";
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
    unread.push({
      crd,
      reason: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
};

/** The `IngressClassParams` an IngressClass names, from its manifest. */
async function parametersOf(className: string): Promise<string | null> {
  try {
    const manifest = await commands.getManifest(
      "IngressClass",
      "networking.k8s.io/v1",
      className,
      null
    );
    const parsed = load(manifest) as
      { spec?: { parameters?: { kind?: string; name?: string } } } | undefined;
    const parameters = parsed?.spec?.parameters;
    if (!parameters?.name) return null;
    // Only this controller's own kind. An IngressClass may point its
    // parameters at anything, and reading somebody else's object as an
    // `IngressClassParams` would invent fields it never had.
    if (parameters.kind && parameters.kind !== "IngressClassParams")
      return null;
    return parameters.name;
  } catch {
    return null;
  }
}

export async function fetchAlbSources(): Promise<AlbSources> {
  const unread: AlbSources["unread"] = [];
  const [ingresses, binding, params, bindings] = await Promise.all([
    commands.listIngresses(null),
    commands.resolveIngressClass(null),
    listKind(INGRESS_CLASS_PARAMS_CRD, unread),
    listKind(TARGET_GROUP_BINDING_CRD, unread),
  ]);

  const ownClasses = binding.available
    .filter((entry) => entry.controller === CONTROLLER)
    .map((entry) => entry.name);

  const named = await Promise.all(
    ownClasses.map(async (name) => [name, await parametersOf(name)] as const)
  );

  return {
    ingresses,
    params,
    bindings,
    classParams: new Map(
      named.flatMap(([name, parameters]) =>
        parameters ? [[name, parameters] as const] : []
      )
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
