import { CircleX, Lock } from "lucide-react";

import { useT } from "@/i18n/useT";
import { EventRows } from "@/components/object/detail-blocks";
import { ReadAgain } from "@/components/ui/read-again";
import { Skeleton } from "@/components/ui/skeleton";
import type { EventInfo } from "@/generated/types";
import {
  eventsUnreadWords,
  type ObjectEventsQuery,
} from "@/hooks/useObjectEvents";
import { errorToShow, isRefusal } from "@/lib/error-utils";
import { cn, formatWhen } from "@/lib/utils";

/**
 * One object's events as the page and the peek both draw them: refused,
 * failing, still reading, or read and none, each said apart.
 */
export function ObjectEventsBody({
  query,
  everyObject,
  none,
  shown,
  compact = false,
}: {
  query: ObjectEventsQuery;
  everyObject: boolean;
  none?: string;
  /** The rows to draw where only some of the answer fits. */
  shown?: EventInfo[];
  compact?: boolean;
}) {
  const t = useT();
  const { data, error } = query;
  if (error) {
    const refused = isRefusal(error);
    return (
      <div className="py-1" data-testid="events-unread">
        <p
          data-read={refused ? "refused" : "failed"}
          className={cn(
            "flex items-center gap-1.5 text-xs",
            refused ? "text-warn" : "text-err"
          )}
        >
          {refused ? (
            <Lock className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
          ) : (
            <CircleX className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
          )}
          {t("empty", eventsUnreadWords(error))}
        </p>
        <p className="mt-1 select-text wrap-break-word font-mono text-[11px] text-fg-fnt">
          {errorToShow(error)}
        </p>
        <ReadAgain
          error={error}
          onRetry={() => void query.refetch()}
          className="mt-1.5"
        />
      </div>
    );
  }
  if (!data)
    return (
      <div className="flex flex-col gap-1.5" data-testid="events-reading">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-3/4" />
      </div>
    );
  return (
    <EventRows
      events={shown ?? data}
      showObject={everyObject}
      compact={compact}
      emptyMessage={
        <>
          {none ??
            t(
              "empty",
              everyObject ? "noEventsInNamespace" : "noEventsForObject"
            )}
          <span className="mt-0.5 block text-[11px]">
            {t("empty", "eventsNoneReadAt", {
              time: formatWhen(query.dataUpdatedAt, "clock"),
            })}
          </span>
        </>
      }
    />
  );
}
