import { commands } from "@/lib/commands";
import { T } from "@/i18n/T";
import { useClusterStore } from "@/stores/clusterStore";
import { ColumnDef } from "@tanstack/react-table";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { Eye, Trash2, ExternalLink } from "lucide-react";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { queryKeys } from "@/lib/query-keys";
import { covers } from "@/lib/certificates";
import { useResourceList } from "@/hooks/useResource";
import { useIngressTls } from "@/hooks/useIngressTls";
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
import { useT } from "@/i18n/useT";

/**
 * What a cloud controller says about these rows' TLS, handed to the cells
 * through a context.
 *
 * The same shape the Delivery column uses, and for the same reason: the
 * answer is one read for the whole page, and a cell that asked on its own
 * behalf would turn it into one call per row. The column's own default is
 * `spec.tls`, which is right on a self-managed cluster and empty on all three
 * managed clouds.
 */
const VendorTls = createContext<
  ((ingress: IngressInfo) => { hosts: string[]; by: string } | null) | null
>(null);

function VendorTlsCell({ ingress }: { ingress: IngressInfo }) {
  const of = useContext(VendorTls);
  return (
    <TlsBadge
      tlsHosts={ingress.tlsHosts}
      hasCatchAllTls={ingress.hasCatchAllTls}
      vendor={of?.(ingress) ?? null}
    />
  );
}

/** The copy label is a word, so the cell needs the hook the array cannot use. */
function IngressAddressCell({ ingress }: { ingress: IngressInfo }) {
  const t = useT();
  const ips = ingress.loadBalancerIps;
  // No address is the state worth naming: the ingress exists but is not
  // reachable yet.
  if (ips.length === 0)
    return <span className="text-fg-fnt">{t("empty", "pendingInline")}</span>;
  return (
    <span className="flex items-baseline gap-2">
      <CopyableAddress
        value={ips[0]}
        label={t("columns", "ingressAddress")}
        className="text-fg-mid"
      />
      {ips.length > 1 && (
        <span className="text-[11px] text-fg-fnt">
          {t("count", "plusMore", { n: ips.length - 1 })}
        </span>
      )}
    </span>
  );
}

const getIngressOpenUrl = (
  ingress: IngressInfo,
  /** Hosts a controller terminates that `spec.tls` never mentions. */
  vendorHosts: string[] = []
): string | null => {
  const host =
    ingress.rules.find((rule) => rule.host && rule.host !== "*")?.host ||
    ingress.loadBalancerIps[0];

  if (!host) {
    return null;
  }

  // `covers` rather than equality: `*.example.com` is how a wildcard Secret
  // serves `shop.example.com`, and a literal comparison offered http:// for
  // every subdomain behind one.
  const usesTls =
    covers(ingress.tlsHosts, host) ||
    ingress.hasCatchAllTls ||
    vendorHosts.includes(host);
  const scheme = usesTls ? "https" : "http";
  return `${scheme}://${host}`;
};

// Exported for `column-widths.test.ts`, at the cost of this file's fast
// refresh: a save remounts the page instead of hot-swapping it.
// eslint-disable-next-line react-refresh/only-export-components
export const baseColumns: ColumnDef<IngressInfo>[] = [
  createNameColumn<IngressInfo>(ResourceType.Ingress),
  createNamespaceColumn<IngressInfo>(),
  {
    // An ingress class name: "nginx", "traefik", "alb".
    size: 110,
    accessorKey: "className",
    header: () => <T section="columns" k="class" />,
    cell: ({ row }) => (
      <span className="text-fg-mut">{row.original.className || "default"}</span>
    ),
  },
  {
    // The column people came to this page to read, and a hostname is long.
    size: 280,
    accessorKey: "rules",
    header: () => <T section="columns" k="hosts" />,
    cell: ({ row }) => {
      const hosts = row.original.rules
        .map((rule) => rule.host)
        .filter((host): host is string => Boolean(host));
      if (hosts.length === 0) {
        const fallback = row.original.defaultBackend?.backendService;
        return (
          <span className="font-mono text-fg-mut">
            *{fallback && <span className="text-fg-fnt"> → {fallback}</span>}
          </span>
        );
      }
      return (
        <Tooltip>
          <TooltipTrigger className="flex flex-wrap items-baseline gap-x-2 font-mono text-fg-mid">
            {hosts.slice(0, 2).map((host) => (
              <span key={host}>{host}</span>
            ))}
            {hosts.length > 2 && (
              <span className="text-fg-fnt">
                <T
                  section="count"
                  k="plusMore"
                  values={{ n: hosts.length - 2 }}
                />
              </span>
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
    // "12 paths", with the routes themselves in the tooltip.
    size: 90,
    id: "paths",
    header: () => <T section="columns" k="paths" />,
    cell: ({ row }) => {
      const allPaths = row.original.rules.flatMap((rule) => rule.paths);
      if (allPaths.length === 0) return <span className="text-fg-fnt">—</span>;
      return (
        <Tooltip>
          <TooltipTrigger className="text-fg-mut">
            <T section="count" k="paths" values={{ n: allPaths.length }} />
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
    // An IPv4 address and a "+2 more" beside it.
    size: 150,
    accessorKey: "loadBalancerIps",
    header: () => <T section="columns" k="address" />,
    cell: ({ row }) => <IngressAddressCell ingress={row.original} />,
  },
  {
    size: 80,
    accessorKey: "tlsHosts",
    header: "TLS",
    cell: ({ row }) => <VendorTlsCell ingress={row.original} />,
  },
  createAgeColumn<IngressInfo>(),
];

export function IngressList() {
  const t = useT();
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
        title: t("action", "realtimeUnavailable"),
        description: t("action", "realtimeFallback", {
          kind: toPlural(ResourceType.Ingress),
          error: err,
        }),
      });
    },
    [t, toast, watchFailed]
  );
  const { resyncing } = useResourceWatch<IngressInfo>({
    enabled: true,
    subscribe,
    queryKey,
    onError: handleWatchError,
    onRecovered: useCallback(() => setWatchFailed(false), []),
  });

  // A second observer on the list's own cache entry, so the rows cost one
  // request and not two — the same trick the sidebar counts use.
  const listed = useResourceList<IngressInfo[]>(queryKey, () =>
    commands.listIngresses({
      namespace: currentNamespace || null,
      labelSelector: null,
      fieldSelector: null,
      limit: null,
    })
  );
  const asked = useMemo(
    () =>
      (listed.data ?? []).map((ingress) => ({
        namespace: ingress.namespace,
        name: ingress.name,
        hosts: ingress.rules.flatMap((rule) => (rule.host ? [rule.host] : [])),
      })),
    [listed.data]
  );
  const vendorTls = useIngressTls(asked);
  const vendorFor = useCallback(
    (ingress: IngressInfo) => {
      const hosts = ingress.rules.flatMap((rule) =>
        rule.host && vendorTls.of(ingress, rule.host)?.terminated
          ? [rule.host]
          : []
      );
      if (hosts.length === 0) return null;
      const by =
        vendorTls.of(ingress, hosts[0])?.by ??
        t("empty", "theLoadBalancerInFront");
      return { hosts, by };
    },
    [t, vendorTls]
  );

  const quickActions = useMemo<
    (setDeleteTarget: (item: IngressInfo) => void) => QuickAction<IngressInfo>[]
  >(
    () => (setDeleteTarget) => [
      {
        icon: Eye,
        label: t("action", "viewDetails"),
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
        label: t("action", "openInBrowser"),
        onClick: (item) => {
          const url = getIngressOpenUrl(item, vendorFor(item)?.hosts ?? []);
          if (url) window.open(url, "_blank", "noreferrer");
        },
        hidden: (item) => !getIngressOpenUrl(item),
      },
      {
        icon: Trash2,
        label: t("action", "delete"),
        onClick: (item) => setDeleteTarget(item),
        variant: "destructive",
      },
    ],
    [t, navigate, vendorFor]
  );

  return (
    <VendorTls.Provider value={vendorFor}>
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
        refresh={watchFailed ? undefined : false}
        live={!watchFailed}
        resyncing={resyncing}
        searchKey="name"
        getRowHref={(row) =>
          getResourceDetailUrl(ResourceType.Ingress, row.name, row.namespace)
        }
      />
    </VendorTls.Provider>
  );
}
