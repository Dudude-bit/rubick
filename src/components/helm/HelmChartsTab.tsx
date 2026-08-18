import { Download, RefreshCw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DetailAction } from "@/components/resources/detail-blocks";
import type { HelmChartSearchResult } from "@/generated/types";
import { useT } from "@/i18n/useT";

export interface HelmChartsTabProps {
  searchKeyword: string;
  onSearchKeywordChange: (next: string) => void;
  results: HelmChartSearchResult[];
  isSearching: boolean;
  onSearch: () => void;
  onInstall: (chart: HelmChartSearchResult) => void;
}

export function HelmChartsTab({
  searchKeyword,
  onSearchKeywordChange,
  results,
  isSearching,
  onSearch,
  onInstall,
}: HelmChartsTabProps) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="relative max-w-md flex-1">
          <Search
            className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-fnt"
            aria-hidden="true"
          />
          <Input
            placeholder="Search charts — nginx, redis, postgresql…"
            value={searchKeyword}
            onChange={(e) => onSearchKeywordChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSearch()}
            className="pl-8"
          />
        </div>
        <Button
          onClick={onSearch}
          disabled={isSearching || !searchKeyword.trim()}
        >
          {isSearching ? (
            <RefreshCw className="h-4 w-4 animate-spin" />
          ) : (
            "Search"
          )}
        </Button>
      </div>

      {results.length === 0 ? (
        <p className="py-8 text-center text-xs text-fg-fnt">
          Add a repository, then search it for charts.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Chart</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>App version</TableHead>
              <TableHead>Description</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.map((chart) => (
              <TableRow key={`${chart.name}-${chart.version}`}>
                <TableCell className="font-mono text-fg">
                  {chart.name}
                </TableCell>
                <TableCell className="font-mono text-fg-mut">
                  {chart.version}
                </TableCell>
                <TableCell className="font-mono text-fg-fnt">
                  {chart.appVersion || "—"}
                </TableCell>
                <TableCell className="max-w-[320px] truncate text-fg-fnt">
                  {chart.description || "—"}
                </TableCell>
                <TableCell>
                  <span className="flex justify-end">
                    <DetailAction
                      label={t("action", "install")}
                      icon={Download}
                      onClick={() => onInstall(chart)}
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
