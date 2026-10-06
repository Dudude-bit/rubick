import type { ColumnDef } from "@/components/ui/table-features";
import { columnHeader } from "@/i18n/column-header";
import { ExternalLink } from "lucide-react";
import type { ServiceInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import { PortsDisplay } from "../../-components";
import { AddressCell } from "@/components/ui/copyable-value";
import { BalancerAddress } from "../../../-object/BalancerAddress";
import { BackingAround, HealthCell } from "./ServiceHealthCell";
import {
  createNameColumn,
  createNamespaceColumn,
  createAgeColumn,
} from "../../../-list/columns";
import { createResourceListPage } from "../../../-list/createResourceListPage";
import { None } from "@/components/ui/none";

/**
 * A service type is a configuration fact, so it is printed rather than badged.
 * The one distinction worth a cue is whether the service is reachable from
 * outside the cluster, and that reads as weight — a coloured pill on every
 * LoadBalancer row would claim something is wrong when nothing is.
 */
const EXTERNALLY_REACHABLE = new Set(["NodePort", "LoadBalancer"]);

export const columns = (): ColumnDef<ServiceInfo>[] => [
  createNameColumn<ServiceInfo>(ResourceType.Service),
  createNamespaceColumn<ServiceInfo>(),
  {
    // "ExternalName" is the longest word this column ever holds.
    size: 120,
    accessorKey: "type",
    header: columnHeader("columns", "type"),
    cell: ({ row }) => (
      <span
        className={
          EXTERNALLY_REACHABLE.has(row.original.type)
            ? "text-fg"
            : "text-fg-mut"
        }
      >
        {row.original.type}
      </span>
    ),
  },
  {
    // "ни один не готов" is the widest verdict here, whole at 160.
    size: 160,
    id: "health",
    header: columnHeader("columns", "endpoints"),
    cell: ({ row }) => <HealthCell service={row.original} />,
  },
  {
    // `255.255.255.255` and its copy mark, whole at 1440px.
    size: 150,
    accessorKey: "clusterIp",
    header: columnHeader("columns", "clusterIp"),
    cell: ({ row }) => (
      <AddressCell value={row.original.clusterIp} labelKey="clusterIp" />
    ),
  },
  {
    // An address per line, each behind an icon; "некому назначить" whole.
    size: 170,
    accessorKey: "externalIps",
    header: columnHeader("columns", "externalIps"),
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
    // Two `80:30080/TCP` mappings and a "+3" after them; a named port that
    // still does not fit ends in an ellipsis, whole in its tooltip.
    size: 200,
    id: "ports",
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
  createAgeColumn<ServiceInfo>(),
];

export const ServiceList = createResourceListPage<ServiceInfo>({
  resourceType: ResourceType.Service,
  title: "Services",
  fetcher: ({ scope }) => commands.listServicesIn(scope),
  watch: ({ scope }) => commands.subscribeServiceWatch(scope),
  deleter: (item) => commands.deleteService(item.name, item.namespace),
  columns,
  around: BackingAround,
});
