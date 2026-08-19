/**
 * One list page per route kind, from one factory.
 *
 * The five kinds share `RouteInfo` — the same parentRefs up and backendRefs
 * down — so the columns are shared too, and a kind contributes only its
 * name. What differs between kinds (path matches, SNI, ports) belongs to
 * the detail page; a list's job is who attaches where and whether anything
 * accepted it.
 */

import { createResourceListPage } from "./createResourceListPage";
import {
  createAgeColumn,
  createNameColumn,
  createNamespaceColumn,
} from "./columns";
import { commands } from "@/lib/commands";
import { ResourceType, type ResourceKind } from "@/lib/resource-registry";
import type { RouteInfo } from "@/generated/types";

/**
 * What the controllers said, reduced honestly: every parent verdict that
 * exists, and "no controller answered" where none does — which is not the
 * same row as "accepted".
 */
function acceptance(route: RouteInfo): {
  text: string;
  tone: "ok" | "err" | "mute";
} {
  const verdicts = route.parents.flatMap((parent) =>
    parent.conditions.filter((c) => c.type === "Accepted")
  );
  if (verdicts.length === 0) {
    return { text: "no controller answered", tone: "mute" };
  }
  const refused = verdicts.find((c) => c.status === "False");
  if (refused) {
    return { text: refused.reason ?? "refused", tone: "err" };
  }
  if (verdicts.every((c) => c.status === "True")) {
    return { text: "accepted", tone: "ok" };
  }
  return { text: "unknown", tone: "mute" };
}

const TONE_CLASS = {
  ok: "text-ok",
  err: "text-err",
  mute: "text-fg-fnt",
} as const;

/** `a.example.com +2`, or the honest blank for the kinds with no hostnames. */
function hostsCell(hostnames: string[]): string {
  if (hostnames.length === 0) return "—";
  if (hostnames.length === 1) return hostnames[0];
  return `${hostnames[0]} +${hostnames.length - 1}`;
}

/** Parent names — a `kind: Service` parent is a mesh attachment, said so. */
function parentsCell(route: RouteInfo): string {
  if (route.parentRefs.length === 0) return "—";
  return route.parentRefs
    .map((p) => (p.kind === "Gateway" ? p.name : `${p.name} (mesh)`))
    .join(", ");
}

function makeRouteList(kind: ResourceKind) {
  return createResourceListPage<RouteInfo>({
    resourceType: kind,
    title: `${kind}s`,
    fetcher: ({ namespace }) => commands.listGatewayRoutes(kind, namespace),
    deleter: (item) =>
      commands.deleteGatewayRoute(kind, item.name, item.namespace),
    watch: ({ namespace }) =>
      commands.subscribeGatewayRouteWatch(kind, namespace),
    searchKey: "name",
    columns: () => [
      createNameColumn<RouteInfo>(kind),
      createNamespaceColumn<RouteInfo>(),
      {
        id: "hostnames",
        header: "Hostnames",
        size: 240,
        accessorFn: (route) => route.hostnames.join(","),
        cell: ({ row }) => (
          <span className="truncate">{hostsCell(row.original.hostnames)}</span>
        ),
      },
      {
        id: "parents",
        header: "Attaches to",
        size: 200,
        cell: ({ row }) => (
          <span className="truncate">{parentsCell(row.original)}</span>
        ),
      },
      {
        id: "accepted",
        header: "Accepted",
        size: 180,
        cell: ({ row }) => {
          const said = acceptance(row.original);
          return <span className={TONE_CLASS[said.tone]}>{said.text}</span>;
        },
      },
      {
        id: "rules",
        header: "Rules",
        size: 70,
        cell: ({ row }) => (
          <span className="text-fg-fnt">{row.original.rules.length}</span>
        ),
      },
      createAgeColumn<RouteInfo>(),
    ],
  });
}

export const HTTPRouteList = makeRouteList(ResourceType.HTTPRoute);
export const GRPCRouteList = makeRouteList(ResourceType.GRPCRoute);
export const TLSRouteList = makeRouteList(ResourceType.TLSRoute);
export const TCPRouteList = makeRouteList(ResourceType.TCPRoute);
export const UDPRouteList = makeRouteList(ResourceType.UDPRoute);
