import type { T } from "@/i18n/useT";
import { EventRows, DetailAction } from "@/components/object/detail-blocks";
import {
  countMark,
  kindGlyph,
  type DetailTab,
} from "@/components/object/detail-tab";
import { Section, SectionHeader } from "@/components/ui/section";
import { Skeleton } from "@/components/ui/skeleton";
import { eventTotal, type ObjectEventsQuery } from "@/hooks/useObjectEvents";
import { ResourceType } from "@/lib/resource-registry";

/** One object's events, read by {@link useObjectEvents}: what the peek's latest twenty are out of. */
export function eventsTab(query: ObjectEventsQuery, t: T): DetailTab {
  const { data, error } = query;
  return {
    id: "events",
    label: "Events",
    glyph: kindGlyph(ResourceType.Event),
    mark: error
      ? { shows: "unchecked", says: t("empty", "couldNotReadEvents") }
      : data
        ? countMark(data.length)
        : undefined,
    content: (
      <Section>
        <SectionHeader
          title="Events"
          count={data && data.length > 0 ? eventTotal(data) : undefined}
          actions={
            error && (
              <DetailAction
                label={t("action", "retry")}
                onClick={() => void query.refetch()}
              />
            )
          }
        />
        {error ? (
          <p className="text-xs text-warn">
            {t("empty", "couldNotReadEvents")}
          </p>
        ) : !data ? (
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        ) : (
          <EventRows
            events={data}
            emptyMessage={t("empty", "noEventsForObject")}
          />
        )}
      </Section>
    ),
  };
}
