import type { ColumnDef } from "@tanstack/react-table";
import { T } from "@/i18n/T";
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
} from "./columns";
import { createResourceListPage } from "./createResourceListPage";

export const columns = (): ColumnDef<EndpointsInfo>[] => [
  createNameColumn<EndpointsInfo>(ResourceType.Endpoints),
  createNamespaceColumn<EndpointsInfo>(),
  {
    size: 200,
    id: "endpoints",
    header: "Endpoints",
    cell: ({ row }) => {
      const readyCount = row.original.subsets.reduce(
        (acc, s) => acc + s.addresses.length,
        0
      );
      const notReadyCount = row.original.subsets.reduce(
        (acc, s) => acc + s.notReadyAddresses.length,
        0
      );

      if (readyCount === 0 && notReadyCount === 0) {
        // No backing pods at all is the failure this column exists to
        // surface — it is the one state here that earns a colour.
        return (
          <span className="text-err">
            <T section="empty" k="noEndpoints" />
          </span>
        );
      }

      return (
        <div className="flex items-center gap-2">
          {readyCount > 0 && (
            <Tooltip>
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
            <Tooltip>
              <TooltipTrigger>
                <Badge variant="warning">
                  <T
                    section="count"
                    k="nNotReady"
                    values={{ n: notReadyCount }}
                  />
                </Badge>
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
    header: () => <T section="columns" k="ports" />,
    cell: ({ row }) => {
      const ports = row.original.subsets.flatMap((s) => s.ports);
      if (ports.length === 0) return <span className="text-fg-fnt">—</span>;
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
    header: () => <T section="columns" k="ips" />,
    cell: ({ row }) => {
      const addresses = row.original.subsets.flatMap((s) => s.addresses);
      if (addresses.length === 0) {
        return <span className="text-fg-fnt">—</span>;
      }
      return (
        <Tooltip>
          <TooltipTrigger>
            <span className="font-mono text-fg-mut underline decoration-dotted underline-offset-2">
              {addresses.length}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            <div className="space-y-1 text-xs">
              {addresses.map((addr, i) => (
                <div key={i}>
                  <CopyableAddress value={addr.ip} label="Address" />
                </div>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      );
    },
  },
  createAgeColumn<EndpointsInfo>(),
];

export const EndpointsList = createResourceListPage<EndpointsInfo>({
  resourceType: ResourceType.Endpoints,
  title: "Endpoints",
  description: ({ scope, t }) =>
    t("empty", "endpointsFor", { scope: scope.inWords }),
  searchKey: "name",
  fetcher: ({ namespace }) =>
    commands.listEndpoints({
      namespace,
      labelSelector: null,
      fieldSelector: null,
      limit: null,
    }),
  watch: ({ namespace }) => commands.subscribeEndpointsWatch(namespace),
  // No deleter — read-only resource
  columns,
});
