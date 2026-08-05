import { ExternalLink, Plus, RefreshCw, Trash2 } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DetailAction } from "@/components/resources/detail-blocks";

import type { HelmRepository } from "@/generated/types";

export interface HelmRepositoriesTabProps {
  repositories: HelmRepository[];
  isLoading: boolean;
  isUpdating: boolean;
  onUpdateAll: () => void;
  onAddRepoClick: () => void;
  onDeleteRepo: (name: string) => void;
}

export function HelmRepositoriesTab({
  repositories,
  isLoading,
  isUpdating,
  onUpdateAll,
  onAddRepoClick,
  onDeleteRepo,
}: HelmRepositoriesTabProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1">
        <DetailAction
          label="Add repository"
          icon={Plus}
          onClick={onAddRepoClick}
        />
        <DetailAction
          label="Update all"
          icon={RefreshCw}
          onClick={onUpdateAll}
          busy={isUpdating}
        />
      </div>

      {isLoading ? (
        <p className="py-8 text-center text-xs text-fg-fnt">
          Reading repositories…
        </p>
      ) : repositories.length === 0 ? (
        <p className="py-8 text-center text-xs text-fg-fnt">
          No repositories configured — add one to search for charts.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
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
                    {repo.url}
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                </TableCell>
                <TableCell>
                  <span className="flex justify-end">
                    <DetailAction
                      label="Remove"
                      icon={Trash2}
                      onClick={() => onDeleteRepo(repo.name)}
                      danger
                    />
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
