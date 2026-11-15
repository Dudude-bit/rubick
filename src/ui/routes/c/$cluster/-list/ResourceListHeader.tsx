import { ReactNode } from "react";
import { DataFreshness } from "@/components/ui/realtime";
import { SectionHeader } from "@/components/ui/section";
import { useT } from "@/i18n/useT";
import { HeldLines } from "./HeldLines";

interface ResourceListHeaderProps {
  title: string;
  /** Row count, shown muted beside the heading. */
  count?: ReactNode;
  /** The count is on its way: its place is held so the title does not move when it lands. */
  countPending?: boolean;
  description?: ReactNode;
  actions?: ReactNode;
  /** Timestamp when data was last fetched (from React Query's dataUpdatedAt) */
  dataUpdatedAt?: number;
  /** A watch stream feeds this list and has not failed. */
  live?: boolean;
  /** Polled, and backed off past its rate because nothing is changing. */
  slowed?: boolean;
  /** The last read failed and the rows are from the one before it. */
  stale?: boolean;
  /** A re-read has waited on the cluster past the slow-read grace. */
  slowRead?: boolean;
  /** The cluster refused the last read; see `DataFreshness`. */
  refusedAt?: number | null;
  /** A notice changed while the pointer rested on the table and is waiting for it to leave. */
  held?: boolean;
}

/**
 * A list page is a section of the window, not a page of its own: the tab
 * strip already says which resource is on screen, so the heading is the
 * same 13px section heading used everywhere else rather than a title block.
 */
export function ResourceListHeader({
  title,
  count,
  countPending = false,
  description,
  actions,
  dataUpdatedAt,
  live,
  slowed,
  stale,
  slowRead,
  refusedAt,
  held = false,
}: ResourceListHeaderProps) {
  const t = useT();
  return (
    <SectionHeader
      title={title}
      count={
        count ??
        (countPending ? (
          <span
            aria-hidden="true"
            className="inline-block h-2.5 w-5 animate-pulse rounded bg-hover align-baseline"
          />
        ) : undefined)
      }
      foldActions
      description={description && <HeldLines>{description}</HeldLines>}
      actions={
        <>
          {held && (
            <span className="relative w-0 self-center">
              <span
                role="status"
                data-testid="list-held"
                className="absolute right-3 top-1/2 -translate-y-1/2 whitespace-nowrap text-caption text-fg-mut"
              >
                {t("readings", "listNoticeWaiting")}
              </span>
            </span>
          )}
          {/* First: the room it keeps for its longest reading falls left of the actions. */}
          <DataFreshness
            dataUpdatedAt={dataUpdatedAt}
            live={live}
            slowed={slowed}
            stale={stale}
            slowRead={slowRead}
            refusedAt={refusedAt}
          />
          {actions}
        </>
      }
    />
  );
}
