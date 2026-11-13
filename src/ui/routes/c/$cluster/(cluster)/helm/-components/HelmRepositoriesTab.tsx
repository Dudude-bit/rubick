import { ExternalLink, Plus, RefreshCw, Trash2 } from "lucide-react";

import {
  Table,
  TableActionCell,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DetailAction } from "@/components/object/detail-blocks";

import type { HelmRepository } from "@/generated/types";
import { useT } from "@/i18n/useT";
import { withoutCredentials } from "@/lib/hints";
import { EmptyState } from "@/components/ui/states";
import { Unknown } from "@/components/ui/unknown";
import { Skeleton } from "@/components/ui/skeleton";

export interface HelmRepositoriesTabProps {
  repositories: HelmRepository[] | undefined;
  isLoading: boolean;
  error?: unknown;
  onRetry?: () => unknown;
  isUpdating: boolean;
  onUpdateAll: () => void;
  onAddRepoClick: () => void;
  onDeleteRepo: (name: string) => void;
}

export function HelmRepositoriesTab({
  repositories,
  isLoading,
  error,
  onRetry,
  isUpdating,
  onUpdateAll,
  onAddRepoClick,
  onDeleteRepo,
}: HelmRepositoriesTabProps) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1">
        <DetailAction
          label={t("action", "addRepository")}
          icon={Plus}
          onClick={onAddRepoClick}
        />
        <DetailAction
          label={t("action", "updateAll")}
          icon={RefreshCw}
          onClick={onUpdateAll}
          busy={isUpdating}
        />
      </div>

      {isLoading ? (
        <div role="status" aria-busy="true" className="space-y-2">
          <Skeleton className="h-3 w-48" />
          <Skeleton className="h-3 w-64" />
          <Skeleton className="h-3 w-40" />
        </div>
      ) : error && !repositories ? (
        <Unknown
          question={t("empty", "couldNotReadRepositories")}
          error={error}
          onRetry={onRetry}
        />
      ) : !repositories || repositories.length === 0 ? (
        <EmptyState>{t("empty", "noRepositoriesConfigured")}</EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns", "name")}</TableHead>
              <TableHead>URL</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {repositories.map((repo) => (
              <TableRow key={repo.name}>
                <TableCell className="font-mono text-fg">{repo.name}</TableCell>
                <TableCell>
                  <a
                    href={repo.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-info hover:underline"
                  >
                    {withoutCredentials(repo.url)}
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                </TableCell>
                <TableActionCell>
                  <DetailAction
                    label={t("action", "remove")}
                    icon={Trash2}
                    onClick={() => onDeleteRepo(repo.name)}
                    danger
                  />
                </TableActionCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
