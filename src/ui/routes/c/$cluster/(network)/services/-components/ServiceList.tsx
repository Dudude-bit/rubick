import type { ColumnDef } from "@/components/ui/table-features";
import { columnHeader } from "@/i18n/column-header";
import { ExternalLink } from "lucide-react";
import type { ServiceInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import { PortsDisplay, portsCellPx } from "../../-components";
import { AddressCell, IPV4_CELL_PX } from "@/components/ui/copyable-value";
import { BalancerAddress } from "../../../-object/BalancerAddress";
import { ClusterIpValue } from "../../../-object/ClusterIpValue";
import { BackingAround, HealthCell } from "./ServiceHealthCell";
import {
  createNameColumn,
  createNamespaceColumn,
  createAgeColumn,
  badgeCellPx,
  causeTextPx,
  yielding,
} from "../../../-list/columns";
import type { ServiceBackingRead } from "@/hooks/useServiceBacking";
import type { T } from "@/i18n/useT";
import {
  serviceVerdictOf,
  useScopeBacking,
} from "../../-components/service-backing";
import { serviceVerdictLabels } from "@/lib/service-health";
import { widestText } from "@/lib/text-width";
import { createResourceListPage } from "../../../-list/createResourceListPage";
import { None } from "@/components/ui/none";

/**
 * A service type is a configuration fact, so it is printed rather than badged.
 * The one distinction worth a cue is whether the service is reachable from
 * outside the cluster, and that reads as weight — a coloured pill on every
 * LoadBalancer row would claim something is wrong when nothing is.
 */
const EXTERNALLY_REACHABLE = new Set(["NodePort", "LoadBalancer"]);

/** Verdicts nobody could confirm, which a shared file marks as not read. */
const UNCONFIRMED = new Set(["unknown", "podsUnread"]);

/** The most of an ExternalName's target the column keeps whole; a longer one ends in an ellipsis, whole on hover. */
const TARGET_GLYPHS = 24;
const COPY_MARK_PX = 14;

export const columns = ({
  read,
}: { read?: ServiceBackingRead } = {}): ColumnDef<ServiceInfo>[] => [
  createNameColumn<ServiceInfo>(ResourceType.Service),
  createNamespaceColumn<ServiceInfo>(),
  {
    size: 120,
    accessorKey: "type",
    header: columnHeader("columns", "type"),
    meta: {
      yields: 4,
      // The type, or an ExternalName's target under it with its copy mark:
      // sized for the type alone it read "example…".
      floor: (_t, rows: readonly ServiceInfo[]) =>
        Math.max(
          widestText(["ExternalName", "LoadBalancer"], "sans", 7),
          Math.min(
            widestText(
              rows.flatMap((row) =>
                row.type === "ExternalName" && row.externalName
                  ? [row.externalName]
                  : []
              ),
              "mono",
              7.2
            ),
            TARGET_GLYPHS * 7.2
          ) + COPY_MARK_PX
        ) + 20,
    },
    cell: ({ row }) => (
      <div className="flex min-w-0 flex-col">
        <span
          className={
            EXTERNALLY_REACHABLE.has(row.original.type)
              ? "text-fg"
              : "text-fg-mut"
          }
        >
          {row.original.type}
        </span>
        {row.original.type === "ExternalName" && (
          <AddressCell
            value={row.original.externalName}
            labelKey="externalName"
          />
        )}
      </div>
    ),
  },
  {
    size: 165,
    id: "health",
    header: columnHeader("columns", "endpoints"),
    meta: {
      floor: (t) => badgeCellPx(serviceVerdictLabels(t)),
      ideal: (t, rows: readonly ServiceInfo[]) =>
        badgeCellPx(serviceVerdictLabels(t)) +
        causeTextPx(
          read
            ? rows.flatMap((row) => serviceVerdictOf(row, read, t).reason ?? [])
            : []
        ),
      ...(read && {
        share: (row: ServiceInfo, t: T) => {
          const verdict = serviceVerdictOf(row, read, t);
          return {
            text: verdict.reason
              ? `${verdict.label} · ${verdict.reason}`
              : verdict.label,
            role: verdict.role,
            unread: UNCONFIRMED.has(verdict.code),
          };
        },
      }),
    },
    cell: ({ row }) => <HealthCell service={row.original} />,
  },
  {
    size: 150,
    accessorKey: "clusterIp",
    header: columnHeader("columns", "clusterIp"),
    meta: { yields: 3, floor: IPV4_CELL_PX },
    cell: ({ row }) => <ClusterIpValue clusterIp={row.original.clusterIp} />,
  },
  {
    // An address per line, each behind an icon; "nothing assigns it" whole.
    size: 180,
    accessorKey: "externalIps",
    header: columnHeader("columns", "externalIps"),
    // The address and the 16px icon before it, held only while a row can show one.
    meta: {
      yields: 2,
      floor: (t, rows: readonly ServiceInfo[]) =>
        rows.some(
          (row) => row.externalIps?.length || row.type === "LoadBalancer"
        )
          ? IPV4_CELL_PX + 16
          : widestText([t("empty", "noneLower")], "sans", 7) + 20,
    },
    cell: ({ row }) => {
      const service = row.original;
      if (service.externalIps.length === 0 && service.type !== "LoadBalancer")
        return <None />;
      return (
        <div className="flex flex-col gap-1">
          {service.externalIps.map((ip) => (
            <div key={ip} className="flex items-center gap-1 text-xs">
              <ExternalLink className="h-3 w-3 flex-none" aria-hidden="true" />
              <AddressCell value={ip} labelKey="externalIp" />
            </div>
          ))}
          <BalancerAddress service={service} compact />
        </div>
      );
    },
  },
  {
    // Two mappings and a "+3" after them; a name longer than Cilium's
    // `envoy-metrics` ends in an ellipsis, whole in its tooltip.
    size: 200,
    id: "ports",
    meta: {
      yields: 5,
      floor: (_t, rows: readonly ServiceInfo[]) => portsCellPx(rows, 2),
    },
    accessorFn: (row) =>
      row.ports
        .map((port) =>
          [port.name, port.port, port.protocol].filter(Boolean).join(" ")
        )
        .join(" "),
    header: columnHeader("columns", "ports"),
    cell: ({ row }) => (
      <PortsDisplay ports={row.original.ports} maxDisplay={2} />
    ),
  },
  yielding(createAgeColumn<ServiceInfo>(), 1),
];

export const ServiceList = createResourceListPage<
  ServiceInfo,
  ServiceBackingRead
>({
  resourceType: ResourceType.Service,
  title: "Services",
  fetcher: ({ scope }) => commands.listServicesIn(scope),
  watch: ({ scope }) => commands.subscribeServiceWatch(scope),
  deleter: (item) => commands.deleteService(item.name, item.namespace),
  columns,
  useRead: useScopeBacking,
  around: BackingAround,
});
