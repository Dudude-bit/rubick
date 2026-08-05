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
 * Skeleton for table rows
 */
interface TableSkeletonProps {
  columns?: number;
  rows?: number;
  showSearch?: boolean;
}

function TableSkeleton({
  columns = 4,
  rows = 5,
  showSearch = true,
}: TableSkeletonProps) {
  return (
    <div className="space-y-2 animate-in fade-in duration-200" aria-hidden>
      {showSearch && <Skeleton className="h-7 w-40" />}
      <div className="flex h-6 items-center gap-4 border-b border-hair px-2.5">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className="h-2.5 w-20" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="flex h-6 items-center gap-4 border-b border-hair px-2.5"
        >
          {Array.from({ length: columns }).map((_, j) => (
            <Skeleton key={j} className="h-2.5 w-24" />
          ))}
        </div>
      ))}
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
