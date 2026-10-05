import { commands } from "@/lib/commands";
import { T } from "@/i18n/T";
import { columnHeader } from "@/i18n/column-header";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { scopeCacheKey } from "@/lib/namespace-scope";
import type { ColumnDef } from "@/components/ui/table-features";
import { createContext, useCallback, useContext, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Eye, Trash2, ExternalLink } from "lucide-react";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { queryKeys } from "@/lib/query-keys";
import { useResourceList } from "@/hooks/useResource";
import { useIngressTls } from "@/hooks/useIngressTls";
import { useIngressHealth } from "@/hooks/useIngressHealth";
import { useServiceHealthInputs } from "@/hooks/useServiceHealthInputs";
import { ingressHealthWords } from "@/lib/ingress-health";
import type { Verdict } from "@/lib/service-health";
import { VerdictBadge } from "../../../-object/health-views";
import { hrefOf, objectLink } from "@/lib/links";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CopyableAddress } from "@/components/ui/copyable-value";
import { ResourceList } from "../../../-list/ResourceList";
import {
  createNameColumn,
  createNamespaceColumn,
  createAgeColumn,
} from "../../../-list/columns";
import type { QuickAction } from "@/components/ui/quick-actions";
import {
  TlsBadge,
  ingressOpenUrl,
  vendorTlsAnswer,
  type VendorTlsAnswer,
} from "../../-components";
import { useWatchedList } from "@/hooks/useWatchedList";

import type { IngressInfo, Scoped } from "@/generated/types";
import { STALE_TIMES } from "@/lib/refresh";
import { getResourceRowId } from "@/lib/table-utils";
import { useT } from "@/i18n/useT";
import { None } from "@/components/ui/none";

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
  ((ingress: IngressInfo) => VendorTlsAnswer | null) | null
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

/**
 * Each row's verdict, from the reads the page makes once for every row: the
 * class bindings, the scope's Services, each namespace's TLS Secrets.
 */
const Health = createContext<((ingress: IngressInfo) => Verdict) | null>(null);

function HealthCell({ ingress }: { ingress: IngressInfo }) {
  const of = useContext(Health);
  return of ? <VerdictBadge verdict={of(ingress)} compact /> : null;
}

/** The copy label is a word, so the cell needs the hook the array cannot use. */
function IngressAddressCell({ ingress }: { ingress: IngressInfo }) {
  const t = useT();
  const ips = ingress.loadBalancerIps;
  // Whether one is coming is the status column's to say, from the class.
  if (ips.length === 0) return <None />;
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

// Exported for `column-widths.test.ts`, at the cost of this file's fast
// refresh: a save remounts the page instead of hot-swapping it.
// oxlint-disable-next-line react-refresh/only-export-components
export const baseColumns: ColumnDef<IngressInfo>[] = [
  createNameColumn<IngressInfo>(ResourceType.Ingress),
  createNamespaceColumn<IngressInfo>(),
  {
    // "missing TLS Secret", and its longer Russian, are the widest verdicts.
    size: 150,
    id: "health",
    header: columnHeader("columns", "status"),
    cell: ({ row }) => <HealthCell ingress={row.original} />,
  },
  {
    // An ingress class name: "nginx", "traefik", "alb".
    size: 110,
    accessorKey: "className",
    header: columnHeader("columns", "class"),
    cell: ({ row }) => (
      <span className="text-fg-mut">{row.original.className || "default"}</span>
    ),
  },
  {
    // The column people came to this page to read, and a hostname is long.
    size: 280,
    // The hostnames, not the rules that hold them: an accessor over an array
    // of objects stringifies to `[object Object]`, so the search box matched
    // nothing on the one column people open this page to read.
    id: "hosts",
    accessorFn: (row) =>
      row.rules
        .map((rule) => rule.host)
        .filter((host): host is string => Boolean(host))
        .join(" "),
    header: columnHeader("columns", "hosts"),
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
    header: columnHeader("columns", "paths"),
    meta: {
      share: (row: IngressInfo, t) => {
        const paths = row.rules.flatMap((rule) => rule.paths).length;
        return paths === 0 ? "—" : t("count", "paths", { n: paths });
      },
    },
    cell: ({ row }) => {
      const allPaths = row.original.rules.flatMap((rule) => rule.paths);
      if (allPaths.length === 0) return <None />;
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
    header: columnHeader("columns", "address"),
    cell: ({ row }) => <IngressAddressCell ingress={row.original} />,
  },
  {
    size: 80,
    accessorKey: "tlsHosts",
    header: columnHeader("columns", "tls"),
    cell: ({ row }) => <VendorTlsCell ingress={row.original} />,
  },
  createAgeColumn<IngressInfo>(),
];

const linkOf = (ingress: IngressInfo) =>
  objectLink({
    kind: ResourceType.Ingress,
    name: ingress.name,
    namespace: ingress.namespace,
  })!;

export function IngressList() {
  const t = useT();
  const scope = useNamespaceScope();
  const navigate = useNavigate();

  const cacheKey = scopeCacheKey(scope.scope);
  const listIngresses = () => commands.listIngressesIn(scope.wire);

  const queryKey = useMemo(
    () => queryKeys.resources(ResourceType.Ingress, cacheKey),
    [cacheKey]
  );
  const subscribe = useCallback(
    () => commands.subscribeIngressWatch(scope.wire),
    [scope.wire]
  );

  const { live, refresh, resyncing } = useWatchedList<IngressInfo>({
    enabled: true,
    subscribe,
    queryKey,
    reportFailure: toPlural(ResourceType.Ingress),
  });

  // A second observer on the list's own cache entry, so the rows cost one
  // request and not two — the same trick the sidebar counts use. At the
  // list's own rate: left at the default it polled under a live watch.
  const listed = useResourceList<Scoped<IngressInfo>>(queryKey, listIngresses, {
    refresh,
  });
  const asked = useMemo(
    () =>
      (listed.data?.rows ?? []).map((ingress) => ({
        namespace: ingress.namespace,
        name: ingress.name,
        hosts: ingress.rules.flatMap((rule) => (rule.host ? [rule.host] : [])),
      })),
    [listed.data]
  );
  const vendorTls = useIngressTls(asked);

  const backing = useServiceHealthInputs(scope.wire);
  const healthOfRow = useIngressHealth(listed.data?.rows, backing);
  const healthOf = (ingress: IngressInfo): Verdict =>
    ingressHealthWords(healthOfRow(ingress), t);
  const vendorFor = useCallback(
    (ingress: IngressInfo) => vendorTlsAnswer(ingress, vendorTls, t),
    [t, vendorTls]
  );

  const quickActions = useMemo<
    (setDeleteTarget: (item: IngressInfo) => void) => QuickAction<IngressInfo>[]
  >(
    () => (setDeleteTarget) => [
      {
        icon: Eye,
        label: t("action", "viewDetails"),
        onClick: (item) => navigate(linkOf(item)),
      },
      {
        icon: ExternalLink,
        label: t("action", "openInBrowser"),
        onClick: (item) => {
          const url = ingressOpenUrl(item, vendorFor(item));
          if (url) window.open(url, "_blank", "noreferrer");
        },
        hidden: (item) => !ingressOpenUrl(item, vendorFor(item)),
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
    <Health.Provider value={healthOf}>
      <VendorTls.Provider value={vendorFor}>
        <ResourceList<IngressInfo>
          title="Ingresses"
          queryKey={queryKey}
          getRowId={getResourceRowId}
          queryFn={listIngresses}
          columns={baseColumns}
          quickActions={quickActions}
          emptyStateLabel={toPlural(ResourceType.Ingress)}
          deleteConfig={{
            mutationFn: (item) =>
              commands.deleteIngress(item.name, item.namespace ?? null),
            invalidateQueryKeys: [queryKey],
            resourceType: ResourceType.Ingress,
          }}
          staleTime={STALE_TIMES.resourceList}
          refresh={refresh}
          live={live}
          resyncing={resyncing}
          getRowHref={(row) => hrefOf(linkOf(row))}
        />
      </VendorTls.Provider>
    </Health.Provider>
  );
}
