import { Download, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import type { HelmChartSearchResult } from "@/generated/types";
import { useT } from "@/i18n/useT";
import { None } from "@/components/ui/none";
import { Reading } from "@/components/ui/states";
import { EmptyState } from "@/components/ui/states";
import { Spinner } from "@/components/ui/spinner";
import { Unknown } from "@/components/ui/unknown";

export interface HelmChartsTabProps {
  searchKeyword: string;
  onSearchKeywordChange: (next: string) => void;
  /** The last search and what came of it; `null` before any, and while one is running. */
  search: {
    keyword: string;
    results: HelmChartSearchResult[] | null;
    error: unknown;
  } | null;
  isSearching: boolean;
  onSearch: () => void;
  onInstall: (chart: HelmChartSearchResult) => void;
}

export function HelmChartsTab({
  searchKeyword,
  onSearchKeywordChange,
  search,
  isSearching,
  onSearch,
  onInstall,
}: HelmChartsTabProps) {
  const t = useT();
  const results = search?.results ?? null;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="relative max-w-md flex-1">
          <Search
            className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-fnt"
            aria-hidden="true"
          />
          <Input
            placeholder={t("action", "searchChartsPlaceholder")}
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
          {isSearching && <Spinner size="xs" aria-hidden="true" />}
          {t("action", "search")}
        </Button>
      </div>

      {isSearching ? (
        <Reading>{t("empty", "searchingCharts")}</Reading>
      ) : search?.error ? (
        <Unknown
          question={t("empty", "couldNotSearchCharts", {
            keyword: search.keyword,
          })}
          error={search.error}
          onRetry={onSearch}
        />
      ) : results === null ? (
        <EmptyState icon={Search}>
          {t("empty", "addRepositoryThenSearch")}
        </EmptyState>
      ) : results.length === 0 ? (
        <EmptyState icon={Search}>
          {t("empty", "noChartsMatch", { keyword: search?.keyword ?? "" })}
        </EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns", "chart")}</TableHead>
              <TableHead>{t("columns", "version")}</TableHead>
              <TableHead>{t("columns", "appVersion")}</TableHead>
              <TableHead>{t("columns", "description")}</TableHead>
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
                  {chart.appVersion || <None />}
                </TableCell>
                <TableCell className="max-w-[320px] truncate text-fg-fnt">
                  {chart.description || <None />}
                </TableCell>
                <TableActionCell>
                  <DetailAction
                    label={t("action", "install")}
                    icon={Download}
                    onClick={() => onInstall(chart)}
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
