import { ReactNode } from "react";
import { DataFreshness } from "@/components/ui/realtime";
import { SectionHeader } from "@/components/ui/section";

interface ResourceListHeaderProps {
  title: string;
  /** Row count, shown muted beside the heading. */
  count?: ReactNode;
  description?: string;
  actions?: ReactNode;
  /** Timestamp when data was last fetched (from React Query's dataUpdatedAt) */
  dataUpdatedAt?: number;
  /** A watch stream feeds this list and has not failed. */
  live?: boolean;
  /** Polled, and backed off past its rate because nothing is changing. */
  slowed?: boolean;
}

/**
 * A list page is a section of the window, not a page of its own: the tab
 * strip already says which resource is on screen, so the heading is the
 * same 13px section heading used everywhere else rather than a title block.
 */
export function ResourceListHeader({
  title,
  count,
  description,
  actions,
  dataUpdatedAt,
  live,
  slowed,
}: ResourceListHeaderProps) {
  return (
    <SectionHeader
      title={title}
      count={count}
      description={description}
      actions={
        <>
          {actions}
          <DataFreshness
            dataUpdatedAt={dataUpdatedAt}
            live={live}
            slowed={slowed}
          />
        </>
      }
    />
  );
}
