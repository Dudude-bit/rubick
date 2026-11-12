import { useQuery } from "@tanstack/react-query";
import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { getApiVersion } from "@/lib/resource-registry";

/**
 * Fetch YAML manifest for a resource (for use in callbacks where hooks are not available)
 */
export function fetchResourceYaml(
  resourceKind: string,
  name: string,
  namespace?: string | null
): Promise<string> {
  const apiVersion = getApiVersion(resourceKind);
  return commands.getManifest(
    resourceKind,
    apiVersion,
    name,
    namespace || null
  );
}

/**
 * Hook for loading YAML of a Kubernetes resource
 */
export function useResourceYaml(
  resourceKind: string,
  name: string | undefined,
  namespace: string | undefined,
  activeTab: string
) {
  return useQuery({
    queryKey: queryKeys.manifest(resourceKind, namespace, name),
    queryFn: () => fetchResourceYaml(resourceKind, name!, namespace),
    enabled: activeTab === "yaml" && !!name,
  });
}
