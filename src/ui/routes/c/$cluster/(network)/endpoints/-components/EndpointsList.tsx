import type { ColumnDef } from "@/components/ui/table-features";
import { T } from "@/i18n/T";
import { columnHeader } from "@/i18n/column-header";
import { CircleDot } from "lucide-react";

import type { EndpointsInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import { Badge } from "@/components/ui/badge";
import { CopyableAddress } from "@/components/ui/copyable-value";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  createNameColumn,
  createNamespaceColumn,
  createAgeColumn,
  causeTextPx,
} from "../../../-list/columns";
import { createResourceListPage } from "../../../-list/createResourceListPage";
import { None } from "@/components/ui/none";
import { AddressesCell } from "./EndpointAddresses";
import { NoEndpoints } from "./NoEndpoints";
import { BackingAround } from "../../-components/ServiceBacking";
import { useScopeBacking } from "../../-components/service-backing";
import { NotReadyPill } from "./NotReadyPill";
import {
  WAITS,
  emptyEndpointsVerdict,
  endpointsPodsUnread,
} from "./pods-unread";
import type { ServiceBackingRead } from "@/hooks/useServiceBacking";

/** Every address the object holds: an unready one is still an address. */
const addressesOf = (endpoints: EndpointsInfo) =>
  endpoints.subsets.flatMap((subset) => [
    ...subset.addresses.map((address) => ({ address, ready: true })),
    ...subset.notReadyAddresses.map((address) => ({ address, ready: false })),
  ]);

export const columns = ({
  read,
}: { read?: ServiceBackingRead } = {}): ColumnDef<EndpointsInfo>[] => [
  createNameColumn<EndpointsInfo>(ResourceType.Endpoints),
  createNamespaceColumn<EndpointsInfo>(),
  {
    size: 200,
    id: "endpoints",
    header: columnHeader("columns", "endpoints"),
    meta: {
      ideal: (t, rows: readonly EndpointsInfo[]) =>
        200 +
        causeTextPx(
          rows.flatMap((row) =>
            row.subsets.every(
              (subset) =>
                subset.addresses.length === 0 &&
                subset.notReadyAddresses.length === 0
            )
              ? (emptyEndpointsVerdict(read, row, t)?.words.reason ?? [])
              : []
          )
        ),
      share: (row: EndpointsInfo, t) => {
        const ready = row.subsets.reduce((n, s) => n + s.addresses.length, 0);
        const notReady = row.subsets.reduce(
          (n, s) => n + s.notReadyAddresses.length,
          0
        );
        if (ready === 0 && notReady === 0) {
          const verdict = emptyEndpointsVerdict(read, row, t);
          const waits = verdict && WAITS[verdict.state];
          const label = waits
            ? verdict.words.label
            : t("readings", "healthNoEndpoints");
          const reason = verdict?.words.reason;
          return {
            text: reason ? `${label} · ${reason}` : label,
            role: waits ? verdict.words.role : "err",
            unread: verdict?.state === "podsUnread",
          };
        }
        const podsUnread = notReady > 0 && endpointsPodsUnread(read, row);
        return {
          text: [
            ready > 0 ? t("count", "nReady", { n: ready }) : null,
            notReady > 0 ? t("count", "nNotReady", { n: notReady }) : null,
          ]
            .filter(Boolean)
            .join(", "),
          role: podsUnread ? "neutral" : notReady > 0 ? "warn" : "ok",
          unread: podsUnread,
        };
      },
    },
    cell: ({ row }) => {
      const readyCount = row.original.subsets.reduce(
        (acc, s) => acc + s.addresses.length,
        0
      );
      const notReadyCount = row.original.subsets.reduce(
        (acc, s) => acc + s.notReadyAddresses.length,
        0
      );

      if (readyCount === 0 && notReadyCount === 0)
        return <NoEndpoints endpoints={row.original} />;

      return (
        <div className="flex items-center gap-2">
          {readyCount > 0 && (
            <Tooltip disableHoverableContent={false}>
              <TooltipTrigger>
                <Badge variant="success">
                  <CircleDot className="h-2.5 w-2.5" aria-hidden="true" />
                  <T section="count" k="nReady" values={{ n: readyCount }} />
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                <div className="space-y-1 text-xs">
                  {row.original.subsets.flatMap((s) =>
                    s.addresses.map((addr, i) => (
                      <div key={i}>
                        <CopyableAddress value={addr.ip} label="Address" />
                        {addr.targetRef &&
                          ` (${addr.targetRef.kind}/${addr.targetRef.name})`}
                      </div>
                    ))
                  )}
                </div>
              </TooltipContent>
            </Tooltip>
          )}
          {notReadyCount > 0 && (
            <Tooltip disableHoverableContent={false}>
              <TooltipTrigger>
                <NotReadyPill endpoints={row.original} n={notReadyCount} />
              </TooltipTrigger>
              <TooltipContent>
                <div className="space-y-1 text-xs">
                  {row.original.subsets.flatMap((s) =>
                    s.notReadyAddresses.map((addr, i) => (
                      <div key={i}>
                        <CopyableAddress value={addr.ip} label="Address" />
                        {addr.targetRef &&
                          ` (${addr.targetRef.kind}/${addr.targetRef.name})`}
                      </div>
                    ))
                  )}
                </div>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      );
    },
  },
  {
    // Three `name:port/protocol` triples side by side, and a "+2" after them.
    size: 220,
    id: "ports",
    header: columnHeader("columns", "ports"),
    meta: {
      share: (row: EndpointsInfo, t) => ({
        text:
          row.subsets
            .flatMap((s) => s.ports)
            .map(
              (port) =>
                `${port.name ? `${port.name}:` : ""}${port.port}/${port.protocol}`
            )
            .join(" ") || t("empty", "noneLower"),
        mono: true,
      }),
    },
    cell: ({ row }) => {
      const ports = row.original.subsets.flatMap((s) => s.ports);
      if (ports.length === 0) return <None />;
      // Ports are values, not states: a pill around each one turns a
      // three-item list into three little boxes.
      return (
        <span className="font-mono text-fg-mid">
          {ports
            .slice(0, 3)
            .map(
              (port) =>
                `${port.name ? `${port.name}:` : ""}${port.port}/${port.protocol}`
            )
            .join(" ")}
          {ports.length > 3 && (
            <span className="text-fg-fnt"> +{ports.length - 3}</span>
          )}
        </span>
      );
    },
  },
  {
    // A count, and the addresses themselves are in the tooltip.
    size: 70,
    id: "addresses",
    header: columnHeader("columns", "ips"),
    meta: {
      share: (row: EndpointsInfo, t) => ({
        unread:
          addressesOf(row).some(({ ready }) => !ready) &&
          endpointsPodsUnread(read, row),
        text:
          addressesOf(row)
            .map(({ address, ready }) =>
              ready
                ? address.ip
                : `${address.ip} (${t("count", "notReadyWord")})`
            )
            .join(", ") || t("empty", "noneLower"),
        mono: true,
      }),
    },
    cell: ({ row }) => (
      <AddressesCell
        endpoints={row.original}
        addresses={addressesOf(row.original)}
      />
    ),
  },
  createAgeColumn<EndpointsInfo>(),
];

export const EndpointsList = createResourceListPage<
  EndpointsInfo,
  ServiceBackingRead
>({
  resourceType: ResourceType.Endpoints,
  title: "Endpoints",
  fetcher: ({ scope }) => commands.listEndpointsIn(scope),
  watch: ({ scope }) => commands.subscribeEndpointsWatch(scope),
  // No deleter — read-only resource
  columns,
  useRead: useScopeBacking,
  around: BackingAround,
});
