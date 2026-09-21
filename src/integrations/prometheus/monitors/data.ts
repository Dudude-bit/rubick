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
  readRule,
  rowsOf as alertRowsFrom,
  type RuleRow,
  type RulesRead,
} from "../alerts/model";
import {
  POD_MONITORS_CRD,
  PROMETHEUSES_CRD,
  RULES_CRD,
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

export async function readRules(): Promise<RulesRead> {
  let configured: boolean;
  try {
    configured = (await commands.getPrometheusConnection()) !== null;
  } catch (error) {
    return { state: "unanswered", reason: normalizeTauriError(error) };
  }
  if (!configured) return { state: "notConnected" };
  try {
    return { state: "read", rules: await commands.prometheusRules() };
  } catch (error) {
    return { state: "unanswered", reason: normalizeTauriError(error) };
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
  rules: Kind<CustomResourceInfo>;
  services: Read<ServiceInfo>;
  namespaces: Read<NamespaceInfo>;
  targets: TargetsRead;
  alertRules: RulesRead;
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
    rules,
    services,
    namespaces,
    targets,
    alertRules,
  ] = await Promise.all([
    readKind(SERVICE_MONITORS_CRD, installed),
    readKind(POD_MONITORS_CRD, installed),
    readKind(PROMETHEUSES_CRD, installed),
    readKind(RULES_CRD, installed),
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
    readRules(),
  ]);
  return {
    serviceMonitors,
    podMonitors,
    prometheuses,
    rules,
    services,
    namespaces,
    targets,
    alertRules,
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

/**
 * How many monitors there are, or `null` when that is not known.
 *
 * Two different `null`s, deliberately one: neither kind exists on the
 * cluster, and a list the cluster refused. The second used to fall through
 * to `rowsOfPicture(picture).length`, which drops an `unread` kind — so a
 * 403 on ServiceMonitors put a confident **0** in the sidebar next to a
 * page saying it could not look. A row with no number says less and is
 * true.
 */
export function monitorCount(picture: Picture): number | null {
  const states = [picture.serviceMonitors.state, picture.podMonitors.state];
  if (states.every((state) => state === "absent")) return null;
  if (states.some((state) => state === "unread")) return null;
  return rowsOfPicture(picture).length;
}

/**
 * What the Monitors tab shows beside its label: how many need attention,
 * how many there are, or nothing.
 *
 * The third reader of "how many monitors", and the one that used to answer
 * it with `rowsOfPicture(...).length` — which drops a kind the cluster
 * refused, so a 403 on ServiceMonitors put a confident number on the tab
 * beside a header saying some lists could not be read. It asks
 * {@link monitorCount} now, as the sidebar does.
 */
export function monitorMark(
  picture: Picture
):
  | { shows: "severity"; tone: "err" | "warn"; n: number; total: number | null }
  | { shows: "count"; of: number }
  | null {
  const rows = rowsOfPicture(picture);
  const attention = rows.filter((row) => row.worst !== null);
  const counted = monitorCount(picture);
  if (attention.length > 0)
    return {
      shows: "severity",
      tone: attention.some((row) => row.worst === "err") ? "err" : "warn",
      n: attention.length,
      // Not `attention.length`: the rows that need attention are the ones
      // that were read, and saying "1 of 1" over a list the cluster refused
      // is the same confident number in another sentence.
      total: counted,
    };
  return counted === null ? null : { shows: "count", of: counted };
}

/**
 * The rows of the Alerts tab, from the same picture the page reads.
 *
 * Here so the tab mark and the sidebar dot ask the same function the page
 * does: both were built from the firing alerts alone, so a rule object
 * nothing picks up, or one Prometheus cannot load, left the tab showing a
 * plain count and the dot showing nothing at all.
 */
export function alertRowsOf(picture: Picture): RuleRow[] {
  if (picture.rules.state !== "read") return [];
  const instances =
    picture.prometheuses.state === "read"
      ? {
          state: "read" as const,
          items: picture.prometheuses.items.map(readPrometheus),
        }
      : picture.prometheuses;
  return alertRowsFrom(
    picture.rules.items.map(readRule),
    instances,
    picture.namespaces,
    picture.alertRules
  );
}

/** What the Alerts tab shows beside its label. */
export function alertsMark(
  picture: Picture
):
  | { shows: "severity"; tone: "err" | "warn"; firing: number; broken: number }
  | { shows: "unchecked"; of: number }
  | { shows: "count"; of: number }
  | null {
  if (picture.rules.state !== "read") return null;
  const rows = alertRowsOf(picture);
  const firing = rows.filter((row) => row.group === "firing").length;
  const broken = rows.filter((row) => row.group === "broken").length;
  if (firing > 0 || broken > 0)
    return {
      shows: "severity",
      tone: firing > 0 ? "err" : "warn",
      firing,
      broken,
    };
  // A rule object nobody could read the loading of — no Prometheus
  // connected, or one that did not answer — is not a rule object with
  // nothing to say. The tab wore a plain count over a page of "not
  // checked", which is this app's own third state going quiet on the way
  // to the strip.
  const unchecked = rows.filter((row) => row.group === "unchecked").length;
  if (unchecked > 0) return { shows: "unchecked", of: unchecked };
  return { shows: "count", of: picture.rules.items.length };
}

export function worstTone(
  picture: Picture
): "warn" | "err" | "unchecked" | null {
  const rows = rowsOfPicture(picture);
  // The dot is the worst thing on the page, and the page grew an Alerts tab:
  // a rule object nothing picks up was worse than anything the monitors had
  // to say, and the rail showed nothing.
  const alerts = alertsMark(picture);
  if (rows.some((row) => row.worst === "err")) return "err";
  if (alerts?.shows === "severity" && alerts.tone === "err") return "err";
  if (rows.some((row) => row.worst === "warn")) return "warn";
  if (alerts?.shows === "severity") return "warn";
  // Neither good nor bad: a rule object whose loading nobody could read.
  // The tab says so and the dot stayed empty, which is the same page
  // answering two ways.
  if (alerts?.shows === "unchecked") return "unchecked";
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
