import type { ColumnDef } from "@tanstack/react-table";
import { ExternalLink } from "lucide-react";
import type { ServiceInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import { PortsDisplay } from "@/components/network";
import { CopyableAddress } from "@/components/ui/copyable-value";
import {
  createNameColumn,
  createNamespaceColumn,
  createAgeColumn,
} from "./columns";
import { createResourceListPage } from "./createResourceListPage";

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
    header: "Type",
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
    size: 130,
    accessorKey: "clusterIp",
    header: "Cluster IP",
    cell: ({ row }) => (
      <CopyableAddress value={row.original.clusterIp} label="Cluster IP" />
    ),
  },
  {
    // An address per line, each behind an icon.
    size: 160,
    accessorKey: "externalIps",
    header: "External IPs",
    cell: ({ row }) => {
      const ips = row.original.externalIps;
      if (!ips || ips.length === 0)
        return <span className="text-fg-fnt">—</span>;
      return (
        <div className="flex flex-col gap-1">
          {ips.map((ip, i) => (
            <div key={i} className="flex items-center gap-1 text-xs">
              <ExternalLink className="h-3 w-3 flex-none" aria-hidden="true" />
              <CopyableAddress value={ip} label="External IP" />
            </div>
          ))}
        </div>
      );
    },
  },
  {
    // Two `80:30080/TCP` mappings and a "+3" after them.
    size: 180,
    accessorKey: "ports",
    header: "Ports",
    cell: ({ row }) => (
      <PortsDisplay ports={row.original.ports} maxDisplay={2} />
    ),
  },
  createAgeColumn<ServiceInfo>(),
];

export const ServiceList = createResourceListPage<ServiceInfo>({
  resourceType: ResourceType.Service,
  title: "Services",
  fetcher: ({ namespace }) =>
    commands.listServices({
      namespace,
      labelSelector: null,
      fieldSelector: null,
      limit: null,
      serviceType: null,
    }),
  watch: ({ namespace }) => commands.subscribeServiceWatch(namespace),
  deleter: (item) => commands.deleteService(item.name, item.namespace),
  columns,
});
