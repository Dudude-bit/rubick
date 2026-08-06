import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import { ColumnDef } from "@tanstack/react-table";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Eye, Trash2, ExternalLink } from "lucide-react";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { queryKeys } from "@/lib/query-keys";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CopyableAddress } from "@/components/ui/copyable-value";
import { ResourceList } from "@/components/resources/ResourceList";
import {
  createNameColumn,
  createNamespaceColumn,
  createAgeColumn,
} from "@/components/resources/columns";
import type { QuickAction } from "@/components/ui/quick-actions";
import { TlsBadge } from "@/components/network";
import { useResourceWatch } from "@/hooks/useResourceWatch";
import { useToast } from "@/components/ui/use-toast";

import type { IngressInfo } from "@/generated/types";
import { STALE_TIMES } from "@/lib/refresh";
import { getResourceRowId } from "@/lib/table-utils";

const getIngressOpenUrl = (ingress: IngressInfo): string | null => {
  const host =
    ingress.rules.find((rule) => rule.host && rule.host !== "*")?.host ||
    ingress.loadBalancerIps[0];

  if (!host) {
    return null;
  }

  // Check both explicit TLS hosts and catch-all TLS
  const usesTls = ingress.tlsHosts.includes(host) || ingress.hasCatchAllTls;
  const scheme = usesTls ? "https" : "http";
  return `${scheme}://${host}`;
};

const baseColumns: ColumnDef<IngressInfo>[] = [
  createNameColumn<IngressInfo>(ResourceType.Ingress),
  createNamespaceColumn<IngressInfo>(),
  {
    accessorKey: "className",
    header: "Class",
    cell: ({ row }) => (
      <span className="text-fg-mut">{row.original.className || "default"}</span>
    ),
  },
  {
    accessorKey: "rules",
    header: "Hosts",
    cell: ({ row }) => {
      const hosts = row.original.rules
        .map((rule) => rule.host)
        .filter((host): host is string => Boolean(host));
      if (hosts.length === 0) return <span className="text-fg-mut">*</span>;
      return (
        <Tooltip>
          <TooltipTrigger className="flex flex-wrap items-baseline gap-x-2 font-mono text-fg-mid">
            {hosts.slice(0, 2).map((host) => (
              <span key={host}>{host}</span>
            ))}
            {hosts.length > 2 && (
              <span className="text-fg-fnt">+{hosts.length - 2} more</span>
            )}
          </TooltipTrigger>
          <TooltipContent>
            {hosts.map((host) => (
              <div key={host} className="text-xs">
                {host}
              </div>
            ))}
          </TooltipContent>
        </Tooltip>
      );
    },
  },
  {
    id: "paths",
    header: "Paths",
    cell: ({ row }) => {
      const allPaths = row.original.rules.flatMap((rule) => rule.paths);
      if (allPaths.length === 0) return <span className="text-fg-fnt">—</span>;
      return (
        <Tooltip>
          <TooltipTrigger className="text-fg-mut">
            {allPaths.length} {allPaths.length === 1 ? "path" : "paths"}
          </TooltipTrigger>
          <TooltipContent>
            {allPaths.map((path, i) => (
              <div key={i} className="font-mono text-xs">
                {path.path} → {path.backendService}:{path.backendPort}
              </div>
            ))}
          </TooltipContent>
        </Tooltip>
      );
    },
  },
  {
    accessorKey: "loadBalancerIps",
    header: "Address",
    cell: ({ row }) => {
      const ips = row.original.loadBalancerIps;
      // No address is the state worth naming: the ingress exists but is not
      // reachable yet.
      if (ips.length === 0) return <span className="text-fg-fnt">pending</span>;
      return (
        <span className="flex items-baseline gap-2">
          <CopyableAddress
            value={ips[0]}
            label="Ingress address"
            className="text-fg-mid"
          />
          {ips.length > 1 && (
            <span className="text-[11px] text-fg-fnt">
              +{ips.length - 1} more
            </span>
          )}
        </span>
      );
    },
  },
  {
    accessorKey: "tlsHosts",
    header: "TLS",
    cell: ({ row }) => (
      <TlsBadge
        tlsHosts={row.original.tlsHosts}
        hasCatchAllTls={row.original.hasCatchAllTls}
      />
    ),
  },
  createAgeColumn<IngressInfo>(),
];

export function IngressList() {
  const { currentNamespace } = useClusterStore();
  const navigate = useNavigate();

  const queryKey = useMemo(
    () => queryKeys.resources(ResourceType.Ingress, currentNamespace),
    [currentNamespace]
  );
  const subscribe = useCallback(
    () => commands.subscribeIngressWatch(currentNamespace || null),
    [currentNamespace]
  );

  const { toast } = useToast();
  const [watchFailed, setWatchFailed] = useState(false);
  const handleWatchError = useCallback(
    (err: string) => {
      if (watchFailed) return;
      setWatchFailed(true);
      toast({
        title: "Real-time updates unavailable",
        description: `Ingresses: falling back to periodic refresh. ${err}`,
      });
    },
    [toast, watchFailed]
  );
  useResourceWatch<IngressInfo>({
    enabled: true,
    subscribe,
    queryKey,
    onError: handleWatchError,
    onRecovered: useCallback(() => setWatchFailed(false), []),
  });

  const quickActions = useMemo<
    (setDeleteTarget: (item: IngressInfo) => void) => QuickAction<IngressInfo>[]
  >(
    () => (setDeleteTarget) => [
      {
        icon: Eye,
        label: "View Details",
        onClick: (item) =>
          navigate(
            getResourceDetailUrl(
              ResourceType.Ingress,
              item.name,
              item.namespace
            )
          ),
      },
      {
        icon: ExternalLink,
        label: "Open in Browser",
        onClick: (item) => {
          const url = getIngressOpenUrl(item);
          if (url) window.open(url, "_blank", "noreferrer");
        },
        hidden: (item) => !getIngressOpenUrl(item),
      },
      {
        icon: Trash2,
        label: "Delete",
        onClick: (item) => setDeleteTarget(item),
        variant: "destructive",
      },
    ],
    [navigate]
  );

  return (
    <ResourceList<IngressInfo>
      title="Ingresses"
      queryKey={queryKeys.resources(ResourceType.Ingress, currentNamespace)}
      getRowId={getResourceRowId}
      queryFn={() =>
        commands.listIngresses({
          namespace: currentNamespace || null,
          labelSelector: null,
          fieldSelector: null,
          limit: null,
        })
      }
      columns={baseColumns}
      quickActions={quickActions}
      emptyStateLabel={toPlural(ResourceType.Ingress)}
      deleteConfig={{
        mutationFn: (item) =>
          commands.deleteIngress(item.name, item.namespace ?? null),
        invalidateQueryKeys: [
          queryKeys.resources(ResourceType.Ingress, currentNamespace),
        ],
        resourceType: ResourceType.Ingress,
      }}
      staleTime={STALE_TIMES.resourceList}
      refetchInterval={watchFailed ? undefined : false}
      searchKey="name"
      getRowHref={(row) =>
        getResourceDetailUrl(ResourceType.Ingress, row.name, row.namespace)
      }
    />
  );
}
