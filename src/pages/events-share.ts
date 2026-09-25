import { Filter } from "lucide-react";

import { spanWords } from "@/i18n/say";
import type { T } from "@/i18n/useT";
import { iconSvg } from "@/lib/icon-svg";
import { ORDER, type PlacedSection } from "@/lib/report-parts";
import type { ReportValue } from "@/lib/report";
import { WINDOW_MS, type StoryWindow } from "@/lib/event-stories";

/** The filters narrowing what is on screen, so a shared report is not read
 *  as the whole feed when the reader had typed a search into it. */
export function eventsFiltersSection(
  view: "stories" | "list",
  window: StoryWindow,
  eventType: string,
  query: string,
  limit: string,
  t: T
): PlacedSection {
  const rows: { label: string; values: ReportValue[] }[] = [
    {
      label: t("columns", "view"),
      values: [
        {
          text:
            view === "stories"
              ? t("action", "eventsStories")
              : t("action", "eventsAll"),
        },
      ],
    },
  ];
  if (view === "stories")
    rows.push({
      label: t("action", "storyWindow"),
      values: [{ text: spanWords(WINDOW_MS[window], t) }],
    });
  if (eventType !== "all")
    rows.push({
      label: t("action", "eventType"),
      values: [{ text: eventType }],
    });
  if (query.trim() !== "")
    rows.push({
      label: t("action", "filterEventsPlaceholder"),
      values: [{ text: query.trim(), mono: true }],
    });
  rows.push({
    label: t("action", "eventsFetched"),
    values: [
      {
        text:
          limit === "all"
            ? t("action", "noLimit")
            : t("action", "latestN", { n: limit }),
      },
    ],
  });
  return {
    id: "events-filters",
    order: ORDER.summary,
    title: t("share", "scrFilters"),
    icon: iconSvg(Filter),
    body: { type: "facts", rows },
  };
}
