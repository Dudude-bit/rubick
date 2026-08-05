import type { ColumnDef } from "@tanstack/react-table";
import { ExternalLink } from "lucide-react";
import type { ServiceInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import { getResourceListUrl } from "@/lib/navigation-utils";
import { ServiceTypeBadge, PortsDisplay } from "@/components/network";
import {
  createNameColumn,
  createNamespaceColumn,
  createAgeColumn,
} from "./columns";
import { createResourceListPage } from "./createResourceListPage";

const columns = (): ColumnDef<ServiceInfo>[] => [
  createNameColumn<ServiceInfo>(getResourceListUrl(ResourceType.Service)),
  createNamespaceColumn<ServiceInfo>(),
  {
    accessorKey: "type",
    header: "Type",
    cell: ({ row }) => <ServiceTypeBadge type={row.original.type} />,
  },
  {
    accessorKey: "clusterIp",
    header: "Cluster IP",
    cell: ({ row }) => (
      <span className="font-mono text-sm">{row.original.clusterIp}</span>
    ),
  },
  {
    accessorKey: "externalIps",
    header: "External IPs",
    cell: ({ row }) => {
      const ips = row.original.externalIps;
      if (!ips || ips.length === 0)
        return <span className="text-fg-fnt">—</span>;
      return (
        <div className="flex flex-col gap-1">
          {ips.map((ip, i) => (
            <div key={i} className="flex items-center gap-1 font-mono text-xs">
              <ExternalLink className="h-3 w-3" />
              {ip}
            </div>
          ))}
        </div>
      );
    },
  },
  {
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
