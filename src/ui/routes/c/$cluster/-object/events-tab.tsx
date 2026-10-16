import type { T } from "@/i18n/useT";
import { ObjectEventsBody } from "./ObjectEventsBody";
import {
  countMark,
  kindGlyph,
  type DetailTab,
} from "@/components/object/detail-tab";
import { Section, SectionHeader } from "@/components/ui/section";
import {
  eventsOfEveryObject,
  eventsUnreadWords,
  eventTotal,
  OBJECT_EVENTS_READ,
  type ObjectEventsQuery,
} from "@/hooks/useObjectEvents";
import { ResourceType } from "@/lib/resource-registry";

/** What the tab's count is a count of, said: a bare "4" under the tab reads as nothing. */
const eventCount = (n: number, t: T) =>
  n >= OBJECT_EVENTS_READ
    ? t("count", "eventObjectsLatest", { n: OBJECT_EVENTS_READ })
    : t("count", "eventObjects", { n });

/** One object's events, read by {@link useObjectEvents}: what the peek's latest twenty are out of. */
export function eventsTab(
  query: ObjectEventsQuery,
  t: T,
  subject: { kind: string; name: string; none?: string }
): DetailTab {
  const { data, error } = query;
  const everyObject = eventsOfEveryObject(subject.kind);
  return {
    id: "events",
    label: t("columns", "events"),
    glyph: kindGlyph(ResourceType.Event),
    mark: error
      ? {
          shows: "unchecked",
          says: t("empty", eventsUnreadWords(error)),
        }
      : data
        ? countMark(eventTotal(data))
        : undefined,
    content: (
      <Section>
        <SectionHeader
          title={t("columns", "events")}
          count={
            data && data.length > 0 ? eventCount(data.length, t) : undefined
          }
          description={
            everyObject &&
            t("empty", "eventsOfEveryObjectIn", { namespace: subject.name })
          }
        />
        <ObjectEventsBody
          query={query}
          everyObject={everyObject}
          none={subject.none}
        />
      </Section>
    ),
  };
}
