import { useLiveQuery } from "@/hooks/useLiveQuery";
import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import { useClusterStore } from "@/stores/clusterStore";
import type {
  CustomResourceInfo,
  NamespaceInfo,
  ServiceInfo,
} from "@/generated/types";

import {
  POD_MONITORS_CRD,
  PROMETHEUSES_CRD,
  SERVICE_MONITORS_CRD,
  type TargetsRead,
} from "./model";

export type Read<T> = { ok: true; items: T[] } | { ok: false; reason: string };

async function read<T>(fetch: () => Promise<T[]>): Promise<Read<T>> {
  try {
    return { ok: true, items: await fetch() };
  } catch (error) {
    return { ok: false, reason: normalizeTauriError(error) };
  }
}

const listAll = (crd: string) =>
  commands.listCustomResources(crd, null, null, null);

export const MONITORS_KEY = ["prometheus-operator", "monitors"] as const;
export const MONITORS_STALE = 30_000;
const REFRESH = "resourceList" as const;

/** The monitors are the page; a refused list of them is the page's error. */
export function fetchServiceMonitors(): Promise<CustomResourceInfo[]> {
  return listAll(SERVICE_MONITORS_CRD);
}

export interface Picture {
  podMonitors: Read<CustomResourceInfo>;
  prometheuses: Read<CustomResourceInfo>;
  services: Read<ServiceInfo>;
  namespaces: Read<NamespaceInfo>;
}

export function useServiceMonitors() {
  const context = useClusterStore((state) => state.currentContext);
  return useLiveQuery({
    refresh: REFRESH,
    queryKey: [context, ...MONITORS_KEY],
    queryFn: fetchServiceMonitors,
    staleTime: MONITORS_STALE,
  });
}

/**
 * Everything the monitors are read against. Each is a `Read`: a refused
 * Service list makes "selects" unknown for every ServiceMonitor, not zero.
 */
export function usePicture() {
  const context = useClusterStore((state) => state.currentContext);
  return useLiveQuery({
    refresh: REFRESH,
    queryKey: [context, "prometheus-operator", "picture"],
    queryFn: async (): Promise<Picture> => {
      const [podMonitors, prometheuses, services, namespaces] =
        await Promise.all([
          read(() => listAll(POD_MONITORS_CRD)),
          read(() => listAll(PROMETHEUSES_CRD)),
          read(() =>
            commands.listServices({
              namespace: null,
              serviceType: null,
              labelSelector: null,
              fieldSelector: null,
              limit: null,
            })
          ),
          read(() => commands.listNamespaces()),
        ]);
      return { podMonitors, prometheuses, services, namespaces };
    },
    staleTime: MONITORS_STALE,
  });
}

/**
 * What the connected Prometheus says about its targets, in three states:
 * no Prometheus is configured for this cluster, it did not answer, or here
 * are the targets. Only the third is a fact about scraping.
 */
export function useTargets() {
  const context = useClusterStore((state) => state.currentContext);
  return useLiveQuery({
    refresh: REFRESH,
    queryKey: [context, "prometheus-operator", "targets"],
    queryFn: async (): Promise<TargetsRead> => {
      let configured: boolean;
      try {
        configured = (await commands.getPrometheusConnection()) !== null;
      } catch (error) {
        return { state: "unanswered", reason: normalizeTauriError(error) };
      }
      if (!configured) return { state: "notConnected" };
      try {
        return { state: "read", targets: await commands.prometheusTargets() };
      } catch (error) {
        return { state: "unanswered", reason: normalizeTauriError(error) };
      }
    },
    staleTime: MONITORS_STALE,
  });
}
