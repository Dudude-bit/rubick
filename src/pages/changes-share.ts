import { Eye, History } from "lucide-react";

import type { ChangeItem, ObservedSpan } from "@/lib/changes";
import { journalWords } from "@/lib/changes";
import { iconSvg } from "@/lib/icon-svg";
import type { ReportChange } from "@/lib/report";
import { ORDER, refOf, type PlacedSection } from "@/lib/report-parts";
import type { T } from "@/i18n/useT";

/** In UTC, like every other time in the file: the reader is not in the sender's zone. */
const clock = (ms: number) =>
  `${new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  })} UTC`;

/**
 * The cluster-wide timeline as one row per object, since `report-parts`'
 * `changesSection` narrows to a single subject and this page mixes every
 * workload it watched. A gap is drawn as its own row rather than dropped, so
 * a stretch nobody watched is not read as a stretch nothing happened.
 */
export function changesScreenSection(
  items: readonly ChangeItem[],
  t: T
): PlacedSection {
  const changes: ReportChange[] = items.flatMap((item): ReportChange[] => {
    if (item.kind === "journal") {
      const { entry } = item;
      return [
        {
          at: new Date(entry.at).toISOString(),
          ref: refOf(entry),
          parts: [
            { text: journalWords(entry, t), quiet: false },
            ...(entry.atRelist
              ? [{ text: t("changes", "journalSeenAtRelist"), quiet: true }]
              : []),
          ],
        },
      ];
    }
    if (item.kind === "gap") {
      return [
        {
          at: new Date(item.gap.to).toISOString(),
          ref: null,
          parts: [
            {
              text: t("changes", "notObserved", {
                from: clock(item.gap.from),
                to: clock(item.gap.to),
              }),
              quiet: false,
            },
          ],
        },
      ];
    }
    // The screen only ever hands this section journal entries and gaps; a
    // revision, a delivery or a Helm release row has nowhere to attach on a
    // page with no single object, so it is left for the object's own page.
    return [];
  });
  return {
    id: "changes",
    order: ORDER.changes,
    title: t("share", "sectionChanges"),
    icon: iconSvg(History),
    count: items.filter((item) => item.kind === "journal").length,
    body: {
      type: "changes",
      changes:
        changes.length > 0
          ? changes
          : [
              {
                at: null,
                ref: null,
                parts: [{ text: t("changes", "nothingInWindow"), quiet: true }],
              },
            ],
    },
  };
}

/**
 * Whether this app was watching, and how much of the window it was not: a
 * gap sits inside the changes list as a row, and this says the same fact
 * again as a fact nobody can scroll past.
 */
export function watchedSection(
  watching: ObservedSpan | undefined,
  gaps: number,
  t: T
): PlacedSection {
  const base = watching
    ? t("changes", "watchingNow", { since: clock(watching.from) })
    : t("changes", "notWatchingNow");
  const warn = !watching || gaps > 0;
  return {
    id: "changes-watched",
    order: ORDER.summary,
    title: t("share", "scrWatched"),
    icon: iconSvg(Eye),
    body: {
      type: "text",
      text:
        gaps > 0
          ? `${base} ${t("share", "scrGapsInWindow", { n: gaps })}`
          : base,
      role: warn ? "warn" : undefined,
    },
  };
}
