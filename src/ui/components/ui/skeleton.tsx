import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A placeholder is a shape the real content will occupy — nothing more.
 * The old skeletons drew a filled, shadowed card frame around their bars, so
 * every loading screen promised a layout the loaded screen no longer has.
 */
function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded bg-hover", className)}
      {...props}
    />
  );
}

/**
 * Skeleton for table rows.
 *
 * Drawn from the same column model the table renders: each cell takes its
 * column's declared pixel width, the bar inside it a believable fraction of
 * that, staggered by row so the grid shimmers like content of uneven
 * lengths. A generic run of same-width bars reads as a placeholder for a
 * *different* screen, and the swap to rows is a jolt. Where the list will
 * group its rows, caption stubs hold the group lines' room too.
 */
interface TableSkeletonProps {
  /** The real columns' declared pixel widths, in column order. */
  widths?: number[];
  columns?: number;
  rows?: number;
  showSearch?: boolean;
  /** Match the density the table itself is drawn at. */
  compact?: boolean;
  /** The list groups its rows, so the loading shape holds caption lines. */
  grouped?: boolean;
}

/** How full a cell's bar draws, cycled so columns read organically. */
const BAR_FRACTIONS = [0.72, 0.45, 0.6, 0.38, 0.52];

function TableSkeleton({
  widths,
  columns = widths?.length ?? 4,
  rows = 14,
  showSearch = true,
  compact = false,
  grouped = false,
}: TableSkeletonProps) {
  // The px lives on the cells, as it does on the real table's cells.
  const cellPadding = compact ? "py-[3px]" : "py-2";
  const widthOf = (column: number) => widths?.[column] ?? 100;
  const barWidth = (row: number, column: number) => {
    // The name column runs long the way names do; the rest cycle.
    const fraction =
      column === 0
        ? 0.55 + ((row * 7) % 4) * 0.08
        : BAR_FRACTIONS[(row + column * 2) % BAR_FRACTIONS.length];
    return Math.max(16, Math.round((widthOf(column) - 20) * fraction));
  };

  const caption = (key: string) => (
    <div key={key} className="px-2.5 pb-1 pt-3">
      <Skeleton className="h-2.5 w-24" />
    </div>
  );

  return (
    <div className="animate-in fade-in duration-200" aria-hidden>
      {showSearch && <Skeleton className="mb-2 h-7 w-40" />}
      <div className="flex items-center border-b border-hair py-1">
        {Array.from({ length: columns }).map((_, column) => (
          <div
            key={column}
            className="px-2.5"
            style={{ width: widthOf(column) }}
          >
            <Skeleton
              className="h-2.5"
              style={{ width: Math.min(56, barWidth(0, column)) }}
            />
          </div>
        ))}
      </div>
      {Array.from({ length: rows }).flatMap((_, row) => [
        // A caption every few rows, the rhythm the grouped list settles into.
        ...(grouped && row % 5 === 0 ? [caption(`caption-${row}`)] : []),
        <div
          key={row}
          className={cn("flex items-center border-b border-hair", cellPadding)}
        >
          {Array.from({ length: columns }).map((_, column) => (
            <div
              key={column}
              className="flex h-4 items-center px-2.5"
              style={{ width: widthOf(column) }}
            >
              <Skeleton
                className="h-2.5"
                style={{ width: barWidth(row, column) }}
              />
            </div>
          ))}
        </div>,
      ])}
    </div>
  );
}

/**
 * Skeleton for a block of key/value rows
 */
interface BlockSkeletonProps {
  showHeader?: boolean;
  lines?: number;
}

function BlockSkeleton({ showHeader = true, lines = 3 }: BlockSkeletonProps) {
  return (
    <div className="space-y-2">
      {showHeader && <Skeleton className="h-3 w-32" />}
      <div className="space-y-1.5 border-t border-hair pt-2">
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton
            key={i}
            className={cn("h-2.5", i === lines - 1 ? "w-[70%]" : "w-full")}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Skeleton for detail pages: title, tab strip, then blocks of rows.
 */
interface DetailSkeletonProps {
  tabCount?: number;
  rows?: number;
  showHeader?: boolean;
}

function DetailSkeleton({
  tabCount = 3,
  rows = 4,
  showHeader = true,
}: DetailSkeletonProps) {
  return (
    <div className="space-y-4 animate-in fade-in duration-200" aria-hidden>
      {showHeader && <Skeleton className="h-3.5 w-64" />}

      <div className="flex gap-1">
        {Array.from({ length: tabCount }).map((_, i) => (
          <Skeleton key={i} className="h-6 w-20" />
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {Array.from({ length: rows }).map((_, i) => (
          <BlockSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

/**
 * Skeleton for the overview's composition bars
 */
interface StatsSkeletonProps {
  count?: number;
}

function StatsSkeleton({ count = 4 }: StatsSkeletonProps) {
  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4" aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-[3px] w-full" />
          <Skeleton className="h-2.5 w-24" />
        </div>
      ))}
    </div>
  );
}

/**
 * Skeleton for section headers with optional subtitle
 */
interface HeaderSkeletonProps {
  showSubtitle?: boolean;
}

function HeaderSkeleton({ showSubtitle = true }: HeaderSkeletonProps) {
  return (
    <div className="space-y-1" aria-hidden>
      <Skeleton className="h-3.5 w-40" />
      {showSubtitle && <Skeleton className="h-2.5 w-64" />}
    </div>
  );
}

/**
 * Skeleton for a text block/paragraph
 */
interface TextSkeletonProps {
  lines?: number;
}

function TextSkeleton({ lines = 3 }: TextSkeletonProps) {
  const widths = ["w-full", "w-[92%]", "w-[96%]", "w-[88%]"];

  return (
    <div className="space-y-1.5" aria-hidden>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className={cn(
            "h-2.5",
            i === lines - 1 ? "w-[70%]" : widths[i % widths.length]
          )}
        />
      ))}
    </div>
  );
}

/**
 * Skeleton for page loading (full page placeholder)
 */
interface PageSkeletonProps {
  className?: string;
}

function PageSkeleton({ className }: PageSkeletonProps) {
  return (
    <div
      className={cn(
        "space-y-6 animate-in fade-in duration-200 px-4 py-3.5",
        className
      )}
    >
      <HeaderSkeleton />
      <StatsSkeleton count={4} />
      <TableSkeleton columns={5} rows={6} showSearch={false} />
    </div>
  );
}

export {
  Skeleton,
  TableSkeleton,
  DetailSkeleton,
  StatsSkeleton,
  HeaderSkeleton,
  TextSkeleton,
  PageSkeleton,
};
