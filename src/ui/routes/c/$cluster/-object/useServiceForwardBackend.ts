import { useQuery } from "@tanstack/react-query";

import type { ServiceInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import { queryKeys } from "@/lib/query-keys";
import { STALE_TIMES } from "@/lib/refresh";
import type { ForwardBackend, PeekActionContext } from "../-peek/peek-actions";

/**
 * A Service does not answer a port-forward; the pod behind it does, and which
 * pod that is only exists in its endpoints. Read once for the page and the
 * peek, so the two never disagree about whether a forward can land.
 */
export function useServiceForwardBackend(
  service: ServiceInfo | undefined,
  namespace: string | null | undefined,
  name: string
): Pick<PeekActionContext, "backend" | "backendPending" | "backendError"> & {
  fetching: boolean;
} {
  const query = useQuery({
    queryKey: queryKeys.serviceForwardBackend(namespace, name),
    queryFn: () => resolveServiceBackend(name, namespace!, service!),
    enabled: !!service && !!namespace && service.ports.length > 0,
    staleTime: STALE_TIMES.fast,
    refetchOnWindowFocus: false,
    retry: false,
  });
  return {
    backend: query.data,
    backendPending: query.isPending && query.fetchStatus !== "idle",
    backendError: query.error ? errorToShow(query.error) : null,
    fetching: query.isFetching,
  };
}

async function resolveServiceBackend(
  name: string,
  namespace: string,
  service: ServiceInfo
): Promise<ForwardBackend | null> {
  const endpoints = await commands.getEndpoints(name, namespace);
  for (const subset of endpoints.subsets) {
    const address = subset.addresses.find(
      (entry) => entry.targetRef?.kind === "Pod"
    );
    if (!address?.targetRef) continue;
    const port = subset.ports[0]?.port ?? service.ports[0]?.port;
    if (port === undefined) continue;
    return { podName: address.targetRef.name, port };
  }
  return null;
}
