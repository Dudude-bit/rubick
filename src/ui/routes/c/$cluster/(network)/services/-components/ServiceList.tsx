import type { ColumnDef } from "@/components/ui/table-features";
import { columnHeader } from "@/i18n/column-header";
import { ExternalLink } from "lucide-react";
import type { ServiceInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import { PortsDisplay } from "../../-components";
import { AddressCell, IPV4_CELL_PX } from "@/components/ui/copyable-value";
import { BalancerAddress } from "../../../-object/BalancerAddress";
import { ClusterIpValue } from "../../../-object/ClusterIpValue";
import { BackingAround, HealthCell } from "./ServiceHealthCell";
import {
  createNameColumn,
  createNamespaceColumn,
  createAgeColumn,
  badgeCellPx,
} from "../../../-list/columns";
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

export const columns = (): ColumnDef<ServiceInfo>[] => [
  createNameColumn<ServiceInfo>(ResourceType.Service),
  createNamespaceColumn<ServiceInfo>(),
  {
    size: 120,
    accessorKey: "type",
    header: columnHeader("columns", "type"),
    meta: {
      floor: () => widestText(["ExternalName", "LoadBalancer"], "sans", 7) + 20,
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
    meta: { floor: (t) => badgeCellPx(serviceVerdictLabels(t)) },
    cell: ({ row }) => <HealthCell service={row.original} />,
  },
  {
    size: 150,
    accessorKey: "clusterIp",
    header: columnHeader("columns", "clusterIp"),
    meta: { floor: IPV4_CELL_PX },
    cell: ({ row }) => <ClusterIpValue clusterIp={row.original.clusterIp} />,
  },
  {
    // An address per line, each behind an icon; "nothing assigns it" whole.
    size: 180,
    accessorKey: "externalIps",
    header: columnHeader("columns", "externalIps"),
    // The address and the 16px icon before it.
    meta: { floor: IPV4_CELL_PX + 16 },
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
      floor: () =>
        widestText(["9964→9964"], "mono", 7.2) +
        4 +
        widestText(["envoy-metrics · TCP"], "caption", 6.2) +
        20,
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
