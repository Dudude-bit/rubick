import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useLiveQuery } from "@/hooks/useLiveQuery";

import { useConnections } from "@/hooks/useConnections";
import { useProxyBehind, useServicesRoutes } from "@/hooks/useServiceRoutes";
import { CopyableAddress, CopyableValue } from "@/components/ui/copyable-value";
import { Rail, routeAddress, RouteSource } from "./TrafficChain";
import type { PeekTarget } from "@/hooks/usePeek";
import { commands } from "@/lib/commands";
import { cn } from "@/lib/utils";
import { STALE_TIMES } from "@/lib/refresh";
import { trafficDoors } from "@/lib/traffic-doors";
import { ResourceRef } from "./ResourceRef";
import { ResourceName, RESOURCE_NAME_SHELL } from "./ResourceName";
import { PeekHeading } from "./peek-heading";
import { useT } from "@/i18n/useT";
import { errorToShow } from "@/lib/error-utils";

/**
 * The level above and the level below, so a peek is a place to walk the
 * chain from rather than a dead end. An Endpoints names its Service, a
 * Service names its Endpoints and every way traffic reaches it from
 * outside, a Pod and a workload name the Services in front of them — and
 * every name is a peek of its own, so the tangle unwinds hop by hop
 * without leaving the panel. Ownership already walks through Controlled
 * by; this is the traffic direction.
 *
 * Drawn as one chain on the detail pages' rail, the peeked object mid-rope:
 * what is above it is how traffic arrives, what is below is what answers.
 * Two flat headings used to say that order in words, and read as prose.
 */
export function PeekTraffic({ target }: { target: PeekTarget }) {
  const t = useT();
  const namespace = target.namespace ?? "";
  const service = { namespace, name: target.name };
  const isServiceish = target.kind === "Service" || target.kind === "Endpoints";

  // The core's own edges and the vendors' routes, cached by the same keys
  // their pages use. A Service and its Endpoints share a name by contract,
  // which is what lets the Endpoints panel ask about its Service.
  const conns = useConnections(
    isServiceish ? "Service" : target.kind,
    target.name,
    namespace
  );
  const behind = useProxyBehind(target.kind === "Service" ? service : null);

  const edges = conns.data?.edges ?? [];
  // The Gateways behind the doors carry their addresses on their own list —
  // the same cache the routes list and the trace already share.
  const hasGatewayDoors = edges.some(
    (edge) => edge.relation.verb === "attachesTo" && edge.to.kind === "Gateway"
  );
  const gatewaysQuery = useLiveQuery({
    queryKey: ["gateway-map-gateways"],
    queryFn: () => commands.listGateways(null),
    staleTime: STALE_TIMES.resourceDetail,
    enabled: hasGatewayDoors,
    refresh: false,
  });
  // The doors under their entries: Gateway API and Ingress ways in, each
  // door wearing its verdict — see `lib/traffic-doors`.
  const doors = useMemo(
    () =>
      conns.data
        ? trafficDoors(conns.data, gatewaysQuery.data ?? [], t)
        : { entries: [], mesh: [], unresolved: [] },
    [conns.data, gatewaysQuery.data, t]
  );
  // For a Pod or a workload, the level above is whichever Services stand in
  // front of it — the graph names them from either end of an edge.
  const services = isServiceish
    ? []
    : [
        ...new Map(
          edges
            .flatMap((edge) => [edge.from, edge.to])
            .filter((object) => object.kind === "Service")
            .map((object) => [`${object.namespace}/${object.name}`, object])
        ).values(),
      ];

  // The vendors are asked about the peeked Service itself — or, from a Pod
  // or a workload, about the Services in front of it: an IngressRoute over
  // that Service is this pod's way in just the same, and without this the
  // Service drew as the top of the world.
  const routed = useServicesRoutes(
    isServiceish
      ? [service]
      : services.map((entry) => ({
          namespace: entry.namespace ?? "",
          name: entry.name,
        }))
  );
  const vendorRoutes = [
    ...new Map(
      (isServiceish ? [service] : services)
        .flatMap(
          (entry) =>
            routed.routes.get(`${entry.namespace ?? ""}/${entry.name}`) ?? []
        )
        .filter((route) => route.source.kind !== "Ingress")
        .map((route) => [`${route.host}${route.path}`, route] as const)
    ).values(),
  ];

  // One dot per LEVEL of the path, not per object: two routes to one
  // Service are two doors on one level, and drawing them in sequence read
  // as one hostname flowing into the other. Within a level the entries
  // stack; the arrows run between levels only.
  const shownRoutes = vendorRoutes.slice(0, 6);
  const waysIn: ReactNode[] = [
    // Object first and the address under it, the order every other entry
    // reads in — this line is the router, not its hostname.
    ...shownRoutes.map((route) => (
      <div key={`route/${route.host}${route.path}`}>
        <p className="text-[11px] text-fg-fnt">
          <RouteSource route={route} /> — {route.source.kind}
        </p>
        <p className="text-[11px] text-fg-fnt">
          <CopyableAddress
            value={routeAddress(route)}
            label={t("columns", "address")}
          />
          {route.h2c ? " (gRPC)" : ""}
        </p>
      </div>
    )),
    ...(vendorRoutes.length > shownRoutes.length
      ? [
          <p key="more" className="text-[11px] text-fg-fnt">
            {t("empty", "andMore", {
              n: vendorRoutes.length - shownRoutes.length,
            })}
          </p>,
        ]
      : []),
  ];

  const levels: { key: string; entries: ReactNode[] }[] = [];
  // Each entry — a Gateway with its address, an Ingress — is a level of its
  // own, its doors stacked under it, each door wearing its verdict.
  for (const entry of doors.entries) {
    levels.push({
      key: `entry/${entry.object.kind}/${entry.object.namespace ?? ""}/${entry.object.name}`,
      entries: [
        <div key="entry">
          <p className="flex flex-wrap items-baseline gap-x-1.5 text-[11px] text-fg-fnt">
            <ResourceRef
              kind={entry.object.kind}
              name={entry.object.name}
              namespace={entry.object.namespace}
              showKind={false}
            />
            {entry.ghost && (
              <span
                aria-label={t("empty", "kindDoesNotExist", {
                  kind: entry.object.kind,
                  name: entry.object.name,
                })}
                className="relative top-px flex h-3.5 w-3.5 flex-none items-center justify-center rounded-full border border-dashed border-hair text-[9px] leading-none"
              >
                ?
              </span>
            )}
            {entry.address && (
              <CopyableAddress
                value={entry.address}
                label={t("action", "copyKindAddress", {
                  kind: entry.object.kind,
                })}
              />
            )}
            <span className={entry.ghost ? "text-err" : undefined}>
              —{" "}
              {entry.ghost
                ? t("empty", "metaMissing", { meta: entry.meta })
                : entry.meta}
            </span>
          </p>
          <div className="mt-1 flex flex-col gap-0.5">
            {entry.doors.map((door) => (
              <div
                key={`${door.host}/${door.route?.kind ?? ""}/${door.route?.name ?? ""}`}
                className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-baseline gap-x-1.5 text-xs"
              >
                <span
                  className={cn(
                    "text-[8px] leading-relaxed",
                    // Three readings, not two. A door nobody judged is not
                    // a door that is fine: an Ingress way in is built without
                    // asking who serves its class, and it wore this dot green
                    // while the Ingress's own page said nothing serves it.
                    door.broken
                      ? "text-err"
                      : door.checked
                        ? "text-ok"
                        : "text-fg-fnt"
                  )}
                >
                  ●
                </span>
                <span
                  className={cn(
                    "truncate font-mono",
                    door.broken && "text-fg-mut line-through decoration-err/50"
                  )}
                >
                  {door.copy ? (
                    // What lands on the clipboard may be more than the
                    // label: a hostless door copies the dialable
                    // address:port while showing the listener's :port.
                    <CopyableValue
                      value={door.copy}
                      label={t("action", "copyPair", { pair: door.copy })}
                      quietMark
                    >
                      {door.host}
                    </CopyableValue>
                  ) : (
                    door.host
                  )}
                </span>
                <span className="whitespace-nowrap text-[11px] text-fg-fnt">
                  {door.broken ? (
                    <span className="text-err">{door.broken}</span>
                  ) : (
                    <>
                      {door.route && (
                        <ResourceRef
                          kind={door.route.kind}
                          name={door.route.name}
                          namespace={door.route.namespace}
                          showKind={false}
                        />
                      )}
                      {door.note && <span> {door.note}</span>}
                    </>
                  )}
                </span>
              </div>
            ))}
            {entry.moreDoors > 0 && (
              <p className="pl-[16px] text-[11px] text-fg-fnt">
                {t("empty", "andMore", { n: entry.moreDoors })}…
              </p>
            )}
          </div>
        </div>,
      ],
    });
  }
  if (waysIn.length > 0) levels.push({ key: "ways-in", entries: waysIn });
  if (services.length > 0) {
    levels.push({
      key: "in-front",
      entries: services.map((entry) => (
        <p
          key={`${entry.namespace}/${entry.name}`}
          className="text-[11px] text-fg-fnt"
        >
          <ResourceRef
            kind="Service"
            name={entry.name}
            namespace={entry.namespace}
            showKind={false}
          />{" "}
          — {t("empty", "theServiceInFront")}
        </p>
      )),
    });
  }
  if (target.kind === "Endpoints") {
    levels.push({
      key: "publishes",
      entries: [
        <p key="publishes" className="text-[11px] text-fg-fnt">
          <ResourceRef
            kind="Service"
            name={target.name}
            namespace={namespace}
            showKind={false}
          />{" "}
          — {t("empty", "theServiceEndpointsPublish")}
        </p>,
      ],
    });
  }
  levels.push({
    key: "self",
    entries: [
      <p key="self" className="text-[11px] text-fg-fnt">
        {/* The selection tint the app already means "current" by. */}
        <span className={cn(RESOURCE_NAME_SHELL, "bg-sel")}>
          <ResourceName
            kind={target.kind}
            name={target.name}
            showKind={false}
          />
        </span>{" "}
        — {t("empty", "thisKind", { kind: target.kind })}
      </p>,
    ],
  });
  if (target.kind === "Service") {
    levels.push({
      key: "behind",
      entries: [
        <p key="endpoints" className="text-[11px] text-fg-fnt">
          <ResourceRef
            kind="Endpoints"
            name={target.name}
            namespace={namespace}
            showKind={false}
          />{" "}
          — {t("empty", "addressesAnswering")}
        </p>,
        ...(behind
          ? [
              <p key="proxy" className="text-[11px] text-fg-fnt">
                {t("count", "vendorProxyHosts", {
                  vendor: behind.vendor,
                  n: behind.hosts,
                })}{" "}
                <Link
                  to={behind.to}
                  className="text-info underline-offset-2 hover:underline"
                >
                  {t("empty", "itsPage")}
                </Link>
              </p>,
            ]
          : []),
      ],
    });
  }

  // The object alone is not a chain; a Pod nothing routes stays quiet —
  // unless nobody could look, which is not the same as nothing routing it.
  if (levels.length === 1 && !conns.error) return null;

  return (
    <div>
      <PeekHeading title={t("nav", "trafficPath")} />
      {conns.error && (
        <p className="py-1 text-xs text-warn">
          {t("empty", "couldNotReadConnections", {
            reason: errorToShow(conns.error),
          })}
        </p>
      )}
      <div className="pb-1">
        {levels.map((level, index) => {
          const last = index === levels.length - 1;
          return (
            <div
              key={level.key}
              className="grid grid-cols-[7px_minmax(0,1fr)] gap-x-2.5"
            >
              <Rail
                tone="on"
                into={last ? null : "on"}
                here={level.key === "self"}
              />
              <div
                className={cn("flex min-w-0 flex-col gap-1", !last && "pb-2")}
              >
                {level.entries}
              </div>
            </div>
          );
        })}
      </div>
      {doors.unresolved.length > 0 && (
        <p className="mt-1 border-t border-hair pt-2 text-[11px] text-fg-fnt">
          {doors.unresolved.map((route, index) => (
            <span key={`${route.kind}/${route.name}`}>
              {index > 0 && ", "}
              <ResourceRef
                kind={route.kind}
                name={route.name}
                namespace={route.namespace}
                showKind={false}
              />
            </span>
          ))}{" "}
          {t("count", "gwParentUnresolved", { n: doors.unresolved.length })}
        </p>
      )}
      {doors.mesh.length > 0 && (
        <p className="mt-1 border-t border-hair pt-2 text-[11px] text-fg-fnt">
          {doors.mesh.map((route, index) => (
            <span key={`${route.kind}/${route.name}`}>
              {index > 0 && ", "}
              <ResourceRef
                kind={route.kind}
                name={route.name}
                namespace={route.namespace}
                showKind={false}
              />
            </span>
          ))}{" "}
          {t("count", "gwMeshAlsoNames", { n: doors.mesh.length })}
        </p>
      )}
    </div>
  );
}
