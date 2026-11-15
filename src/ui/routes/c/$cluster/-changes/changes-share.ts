import { Eye, History } from "lucide-react";

import type { Show } from "@/generated/types";
import type { ChangeItem, SpanCover, SpanLike } from "@/lib/changes";
import {
  changesKnownFrom,
  earlierRowsWords,
  gapWords,
  letGoWords,
  quietSince,
  rowWords,
  unwatchedWords,
} from "@/lib/changes";
import { errorToShow } from "@/lib/error-utils";
import type { TimelineRead } from "@/hooks/useTimeline";
import { iconSvg } from "@/lib/icon-svg";
import type { ReportChange } from "@/lib/report";
import {
  ORDER,
  gapChange,
  refOf,
  utcMoment,
  type PlacedSection,
} from "@/lib/report-parts";
import type { T } from "@/i18n/useT";
import { listWords } from "@/i18n/say";
import { getDisplayPlural } from "@/lib/resource-registry";
import { dateFormat } from "@/lib/utils";
import { currentLocale } from "@/stores/localeStore";

/** In UTC, like every other time in the file: the reader is not in the sender's zone. */
const clock = (ms: number) =>
  `${dateFormat(currentLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  }).format(ms)} UTC`;

/** What keeps the timeline from being whole, as the page says it above its rows. */
export function keepingWords(
  read: Pick<TimelineRead, "keeping" | "unreadable" | "error">,
  t: T
): string[] {
  const lines: string[] = [];
  if (read.error)
    lines.push(t("changes", "readFailed", { reason: errorToShow(read.error) }));
  if (read.keeping?.says === "off") lines.push(t("changes", "keptSessionOnly"));
  if (read.keeping?.says === "failed")
    lines.push(t("changes", "keptFailed", { error: read.keeping.message }));
  if (read.unreadable > 0)
    lines.push(t("changes", "keptUnreadable", { n: read.unreadable }));
  return lines;
}

const SHOW_WORDS = {
  all: null,
  changes: "showChanges",
  warnings: "showWarnings",
} as const satisfies Record<Show, string | null>;

/**
 * The cluster-wide timeline as one row per object, since `report-parts`'
 * `changesSection` narrows to a single subject and this page mixes every
 * object it watched. A gap is drawn as its own row rather than dropped, so
 * a stretch nobody watched is not read as a stretch nothing happened.
 */
export function changesScreenSection(
  items: readonly ChangeItem[],
  t: T,
  /** How far back the screen was looking, as its own toggle words it. */
  window: string,
  show: Show = "all"
): PlacedSection {
  const changes: ReportChange[] = items.flatMap((item): ReportChange[] => {
    if (item.kind === "journal") {
      const { row } = item;
      return [
        {
          at: new Date(row.at).toISOString(),
          ref: refOf({
            kind: row.kind,
            name: row.name,
            namespace: row.namespace,
          }),
          parts: [
            { text: rowWords(row, t), quiet: false },
            ...(row.atRelist
              ? [{ text: t("changes", "journalSeenAtRelist"), quiet: true }]
              : []),
          ],
        },
      ];
    }
    if (item.kind === "event") {
      const { event } = item;
      const said = [event.type, event.reason, event.message]
        .filter(Boolean)
        .join(" · ");
      const count = event.count ?? 0;
      return [
        {
          at: new Date(item.at).toISOString(),
          ref: refOf({
            kind: event.involvedObject.kind,
            name: event.involvedObject.name,
            namespace: event.involvedObject.namespace,
          }),
          parts: [
            { text: count > 1 ? `${said} ×${count}` : said, quiet: false },
          ],
        },
      ];
    }
    if (item.kind === "letGo")
      return [
        {
          at: null,
          ref: null,
          parts: [{ text: letGoWords(item, t, utcMoment), quiet: false }],
        },
      ];
    if (item.kind === "gap") return [gapChange(item.gap, t)];
    if (item.kind === "watched") {
      const refused = item.refused && unwatchedWords(item.refused, t, true);
      return [
        {
          at: new Date(item.at).toISOString(),
          ref: null,
          parts: [
            {
              text: gapWords(
                item.gap,
                t,
                utcMoment,
                item.quiet ? "quiet" : "changed"
              ),
              quiet: true,
            },
            ...(refused ? [{ text: refused, quiet: false }] : []),
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
    count: items.filter(
      (item) => item.kind === "journal" || item.kind === "event"
    ).length,
    caption: [
      t("share", "changesWindow", { window }),
      SHOW_WORDS[show] && t("changes", SHOW_WORDS[show]),
    ]
      .filter(Boolean)
      .join(" · "),
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
/**
 * The kinds the running watch follows, named: a quiet stretch speaks for
 * these and for nothing else. Without the ones it was refused everywhere,
 * which it watches nowhere and cannot call quiet.
 */
export const journalKindsWords = (t: T, watch?: SpanCover): string =>
  listWords(
    (watch?.kinds ?? [])
      .filter((kind) => !watch?.unwatched?.includes(kind))
      .map(getDisplayPlural),
    t
  );

export function watchedSection(
  watching: SpanLike | undefined,
  spans: readonly SpanLike[],
  items: readonly ChangeItem[],
  t: T,
  read?: Pick<TimelineRead, "keeping" | "unreadable" | "error" | "letGo">
): PlacedSection {
  const gaps = items.filter((item) => item.kind === "gap").length;
  const refused = watching && unwatchedWords(watching, t);
  const earlier =
    watching && earlierRowsWords(spans, items, watching.from, t, clock);
  const since = watching
    ? t("changes", "watchingNow", { since: clock(watching.from) })
    : t("changes", "notWatchingNow");
  const quiet = quietSince(watching, items, changesKnownFrom(read?.letGo));
  const nothing =
    quiet !== null &&
    t("changes", "nothingRecordedSince", {
      since: clock(quiet),
      kinds: journalKindsWords(t, watching),
    });
  const keeping = read ? keepingWords(read, t) : [];
  const base = [since, refused, earlier, nothing, ...keeping]
    .filter(Boolean)
    .join(" · ");
  const warn = !watching || gaps > 0 || Boolean(refused) || keeping.length > 0;
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
