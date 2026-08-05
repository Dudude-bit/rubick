import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ColumnDef } from "@tanstack/react-table";
import {
  RefreshCw,
  Trash2,
  History,
  FileCode,
  RotateCcw,
  PauseCircle,
  PlayCircle,
  ExternalLink,
  ArrowUpCircle,
} from "lucide-react";

import { ActionMenu } from "@/components/ui/action-menu";
import { DataTable } from "@/components/ui/data-table";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DetailAction } from "@/components/resources/detail-blocks";
import type { HelmRelease } from "@/generated/types";
import { formatDate } from "@/lib/utils";

import { SourceIcon } from "./SourceIcon";

const getHelmReleaseRowId = (row: HelmRelease) =>
  `${row.source}-${row.namespace}-${row.name}`;

export interface HelmReleasesTabProps {
  releases: HelmRelease[];
  isLoading: boolean;
  helmCliAvailable: boolean;
  namespaces: string[];
  selectedNamespace: string;
  onNamespaceChange: (next: string) => void;
  onRefetch: () => void;
  onShowHistory: (release: HelmRelease) => void;
  onUpgrade: (release: HelmRelease) => void;
  onRollback: (release: HelmRelease) => void;
  onUninstall: (release: HelmRelease) => void;
}

export function HelmReleasesTab({
  releases,
  isLoading,
  helmCliAvailable,
  namespaces,
  selectedNamespace,
  onNamespaceChange,
  onRefetch,
  onShowHistory,
  onUpgrade,
  onRollback,
  onUninstall,
}: HelmReleasesTabProps) {
  const navigate = useNavigate();

  const columns: ColumnDef<HelmRelease>[] = useMemo(
    () => [
      {
        accessorKey: "source",
        header: "Source",
        cell: ({ row }) => <SourceIcon source={row.original.source} />,
        size: 70,
      },
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <button
            className="text-left font-mono text-info hover:underline"
            onClick={() =>
              navigate(
                `/helm/${row.original.source}/${row.original.namespace}/${row.original.name}`
              )
            }
          >
            {row.original.name}
          </button>
        ),
      },
      { accessorKey: "namespace", header: "Namespace" },
      { accessorKey: "revision", header: "Rev", size: 60 },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => {
          const status = row.original.status;
          const suspended = row.original.suspended;
          return (
            <div className="flex items-center gap-1.5">
              <StatusBadge status={suspended ? "suspended" : status} showDot />
            </div>
          );
        },
      },
      {
        accessorKey: "chart",
        header: "Chart",
        cell: ({ row }) => (
          <span className="font-mono text-fg-mut">{row.original.chart}</span>
        ),
      },
      {
        accessorKey: "appVersion",
        header: "App Version",
        cell: ({ row }) => row.original.appVersion || "—",
      },
      {
        accessorKey: "updated",
        header: "Updated",
        cell: ({ row }) => {
          return (
            formatDate(row.original.updated) ?? row.original.updated ?? "—"
          );
        },
      },
      {
        id: "actions",
        size: 50,
        cell: ({ row }) => {
          const release = row.original;
          const isNative = release.source === "native";
          const isFlux = release.source === "flux";

          return (
            <ActionMenu>
              <DropdownMenuItem
                onClick={() =>
                  navigate(
                    `/helm/${release.source}/${release.namespace}/${release.name}`
                  )
                }
              >
                <FileCode className="mr-2 h-4 w-4" />
                View Details
              </DropdownMenuItem>

              <DropdownMenuItem onClick={() => onShowHistory(release)}>
                <History className="mr-2 h-4 w-4" />
                View History
              </DropdownMenuItem>

              <DropdownMenuSeparator />

              {isNative && (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuItem
                        disabled={!helmCliAvailable}
                        onClick={() => onUpgrade(release)}
                      >
                        <ArrowUpCircle className="mr-2 h-4 w-4" />
                        Upgrade
                      </DropdownMenuItem>
                    </TooltipTrigger>
                    {!helmCliAvailable && (
                      <TooltipContent>Helm CLI required</TooltipContent>
                    )}
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuItem
                        disabled={!helmCliAvailable}
                        onClick={() => onRollback(release)}
                      >
                        <RotateCcw className="mr-2 h-4 w-4" />
                        Rollback
                      </DropdownMenuItem>
                    </TooltipTrigger>
                    {!helmCliAvailable && (
                      <TooltipContent>Helm CLI required</TooltipContent>
                    )}
                  </Tooltip>

                  <DropdownMenuSeparator />

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuItem
                        disabled={!helmCliAvailable}
                        className="text-err"
                        onClick={() => onUninstall(release)}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Uninstall
                      </DropdownMenuItem>
                    </TooltipTrigger>
                    {!helmCliAvailable && (
                      <TooltipContent>Helm CLI required</TooltipContent>
                    )}
                  </Tooltip>
                </>
              )}

              {isFlux && (
                <>
                  <DropdownMenuItem disabled>
                    {release.suspended ? (
                      <>
                        <PlayCircle className="mr-2 h-4 w-4" />
                        Resume
                      </>
                    ) : (
                      <>
                        <PauseCircle className="mr-2 h-4 w-4" />
                        Suspend
                      </>
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Reconcile
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() =>
                      navigate(
                        `/crds/helm.toolkit.fluxcd.io/helmreleases/${release.namespace}/${release.name}`
                      )
                    }
                  >
                    <ExternalLink className="mr-2 h-4 w-4" />
                    View CRD
                  </DropdownMenuItem>
                </>
              )}
            </ActionMenu>
          );
        },
      },
    ],
    [
      navigate,
      helmCliAvailable,
      onShowHistory,
      onUpgrade,
      onRollback,
      onUninstall,
    ]
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Select value={selectedNamespace} onValueChange={onNamespaceChange}>
          <SelectTrigger
            aria-label="Namespace"
            className="h-6 w-44 gap-1 border-0 bg-transparent px-1.5 text-[11px] text-fg-mut hover:bg-hover focus:ring-0 focus:ring-offset-0"
          >
            <SelectValue placeholder="All namespaces" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All namespaces</SelectItem>
            {namespaces.map((ns) => (
              <SelectItem key={ns} value={ns}>
                {ns}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto">
          <DetailAction
            label="Refresh"
            icon={RefreshCw}
            onClick={onRefetch}
            busy={isLoading}
          />
        </div>
      </div>

      <DataTable
        columns={columns}
        data={releases}
        isLoading={isLoading}
        searchPlaceholder="Search releases..."
        searchKey="name"
        getRowId={getHelmReleaseRowId}
        getRowHref={(row) => `/helm/${row.source}/${row.namespace}/${row.name}`}
      />
    </div>
  );
}
