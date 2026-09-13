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
  readMonitor,
  readPrometheus,
  rowsOf,
  type Kind,
  type MonitorRow,
  type Read,
  type TargetsRead,
} from "./model";

async function read<T>(fetch: () => Promise<T[]>): Promise<Read<T>> {
  try {
    return { ok: true, items: await fetch() };
  } catch (error) {
    return { ok: false, reason: normalizeTauriError(error) };
  }
}

/**
 * One of the operator's kinds. Asked only when the CRD list says the kind
 * exists; a kind the list does not name is absent, not refused. When the
 * CRD list itself was refused the kind is asked anyway, and its own
 * refusal is what the reader sees.
 */
async function readKind(
  crd: string,
  installed: Set<string> | null
): Promise<Kind<CustomResourceInfo>> {
  if (installed !== null && !installed.has(crd)) return { state: "absent" };
  try {
    return {
      state: "read",
      items: await commands.listCustomResources(crd, null, null, null),
    };
  } catch (error) {
    return { state: "unread", reason: normalizeTauriError(error) };
  }
}

async function readTargets(): Promise<TargetsRead> {
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
}

/**
 * Everything the monitors are read against, each carrying its own third
 * state: a refused Service list makes "selects" unknown for every
 * ServiceMonitor, not zero; a missing Prometheus CRD makes "picked up"
 * not judged, not "nobody".
 */
export interface Picture {
  serviceMonitors: Kind<CustomResourceInfo>;
  podMonitors: Kind<CustomResourceInfo>;
  prometheuses: Kind<CustomResourceInfo>;
  services: Read<ServiceInfo>;
  namespaces: Read<NamespaceInfo>;
  targets: TargetsRead;
}

export async function readPicture(): Promise<Picture> {
  const crds = await read(() => commands.listCrds(false));
  const installed = crds.ok
    ? new Set(crds.items.flatMap((group) => group.crds.map((crd) => crd.name)))
    : null;
  const [
    serviceMonitors,
    podMonitors,
    prometheuses,
    services,
    namespaces,
    targets,
  ] = await Promise.all([
    readKind(SERVICE_MONITORS_CRD, installed),
    readKind(POD_MONITORS_CRD, installed),
    readKind(PROMETHEUSES_CRD, installed),
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
    readTargets(),
  ]);
  return {
    serviceMonitors,
    podMonitors,
    prometheuses,
    services,
    namespaces,
    targets,
  };
}

export function rowsOfPicture(picture: Picture): MonitorRow[] {
  const monitors = [
    ...(picture.serviceMonitors.state === "read"
      ? picture.serviceMonitors.items.map((cr) =>
          readMonitor(cr, "ServiceMonitor")
        )
      : []),
    ...(picture.podMonitors.state === "read"
      ? picture.podMonitors.items.map((cr) => readMonitor(cr, "PodMonitor"))
      : []),
  ];
  const instances =
    picture.prometheuses.state === "read"
      ? {
          state: "read" as const,
          items: picture.prometheuses.items.map(readPrometheus),
        }
      : picture.prometheuses;
  return rowsOf(
    monitors,
    instances,
    picture.services,
    picture.namespaces,
    picture.targets
  );
}

/** `null` where neither monitor kind exists: the row then has no number to carry. */
export function monitorCount(picture: Picture): number | null {
  if (
    picture.serviceMonitors.state === "absent" &&
    picture.podMonitors.state === "absent"
  )
    return null;
  return rowsOfPicture(picture).length;
}

export function worstTone(picture: Picture): "warn" | "err" | null {
  const rows = rowsOfPicture(picture);
  if (rows.some((row) => row.worst === "err")) return "err";
  if (rows.some((row) => row.worst === "warn")) return "warn";
  return null;
}

export const MONITORS_KEY = ["prometheus", "monitors"] as const;
export const MONITORS_STALE = 30_000;

/** The sidebar's count and the page read one cache entry; see `PageCount`. */
export function usePicture() {
  const context = useClusterStore((state) => state.currentContext);
  return useLiveQuery({
    refresh: "resourceList",
    queryKey: [context, ...MONITORS_KEY],
    queryFn: readPicture,
    staleTime: MONITORS_STALE,
  });
}
