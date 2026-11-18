import { Pin } from "lucide-react";

import {
  isChange,
  placedBy,
  recordedNow,
  rowWords,
  type ChangeRow,
} from "@/lib/changes";
import type { TimelineRead } from "@/hooks/useTimeline";
import type { LetGo } from "@/generated/types";
import { errorToShow } from "@/lib/error-utils";
import { iconSvg } from "@/lib/icon-svg";
import { rolloutVerdict } from "@/lib/workload-status";
import type { ReportValue } from "@/lib/report";
import {
  ORDER,
  refOf,
  utcMoment,
  type PlacedSection,
} from "@/lib/report-parts";
import {
  pinKey,
  waysVerdict,
  wayState,
  type EntryPoint,
  type ServicePin,
  type ServiceState,
  type WaysVerdict,
  type WayState,
} from "@/lib/my-services";
import { ASK_SHORT, type Watch } from "@/lib/tell-me-when";
import type { T } from "@/i18n/useT";
import type { UnexploredKind } from "@/generated/types";

/**
 * The newest change a card names: its row; the let-go line where none is
 * kept past what was let go or cleared, which may have held one; `null` for
 * none seen; `undefined` where the timeline was not read.
 */
export type LastChange =
  | ChangeRow
  | LetGo
  /** Kept rows that could not be read: one of them may be the last change. */
  | { unreadable: number }
  /** The last read failed: what changed since is not known. */
  | { failed: string }
  /** Rows kept under the name, and which cluster this is could not be checked. */
  | { unchecked: string | null }
  /** The newest change, and no read placed it: it may be another cluster's. */
  | { unplaced: ChangeRow }
  | null
  | undefined;

export function lastChangeOf(
  read: Pick<
    TimelineRead,
    "read" | "rows" | "letGo" | "unreadable" | "identity" | "error" | "vouched"
  >
): LastChange {
  if (!read.read)
    return read.error ? { failed: errorToShow(read.error) } : undefined;
  // Said of the row as the Changes page says it: one no read placed with
  // its doubt, one the connection held now recorded as it is.
  const latest = read.rows.find(isChange);
  if (latest && !placedBy(latest, read.vouched)) return { unplaced: latest };
  if (latest && recordedNow(latest, read.vouched)) return latest;
  // The Changes page warns of the rest; the card does not name another
  // cluster's row as this service's last change.
  if (read.identity?.says === "unknown")
    return { unchecked: read.identity.message };
  if (read.identity?.says === "unsettled") return { unchecked: null };
  if (latest) return latest;
  if (read.error) return { failed: errorToShow(read.error) };
  if (read.unreadable > 0) return { unreadable: read.unreadable };
  return read.letGo?.changes ?? null;
}

/** The last change in words, the row's own aside, on the card and in its Share. */
export function lastChangeWords(
  latest: LastChange,
  t: T,
  clock: (ms: number) => string
): string {
  if (latest === undefined) return t("services", "notReadYet");
  if (latest === null) return t("services", "nothingSeen");
  if ("unchecked" in latest)
    return latest.unchecked === null
      ? t("services", "lastChangeUnsettled")
      : t("services", "lastChangeUnchecked", { reason: latest.unchecked });
  if ("unplaced" in latest)
    return t("services", "lastChangeUnplaced", {
      change: rowWords(latest.unplaced, t),
    });
  if ("failed" in latest)
    return t("changes", "readFailed", { reason: latest.failed });
  if ("unreadable" in latest)
    return t("changes", "keptUnreadable", { n: latest.unreadable });
  if ("before" in latest)
    return t(
      "services",
      latest.cleared ? "nothingSeenSinceCleared" : "nothingSeenSinceLetGo",
      { at: clock(latest.before) }
    );
  return rowWords(latest, t);
}

/** The card and its Share say the same word beside a way in. */
export const WAY_WORDS: Record<WayState, (t: T) => string> = {
  noController: (t) => t("services", "noControllerServes"),
  noAddress: (t) => t("services", "noAddressPublished"),
  unread: (t) => t("services", "notReadYet"),
  unsure: (t) => t("nav", "notChecked"),
  shut: (t) => t("empty", "stopPolicyShutUnder"),
  empty: (t) => t("services", "nothingBehind"),
};

/** What the header says beside the count where ways in were read as down. */
export function verdictWords(verdict: WaysVerdict, t: T): string {
  switch (verdict.says) {
    case "shut":
      return t("services", "everyWayShut");
    case "empty":
      return t("services", "noWayServes");
    case "some":
      return t("services", "someWaysDown", {
        n: verdict.down,
        of: verdict.of,
      });
  }
}

export const VERDICT_ROLE: Record<WaysVerdict["says"], "err" | "warn"> = {
  shut: "err",
  empty: "err",
  some: "warn",
};

function wayWords(way: EntryPoint, t: T): string {
  const name = way.url ?? way.label;
  const state = wayState(way);
  return state ? `${name} (${WAY_WORDS[state](t)})` : name;
}

function stateValue(
  state: ServiceState,
  verdict: WaysVerdict | null,
  t: T
): ReportValue {
  const cutOff = (value: ReportValue): ReportValue =>
    verdict
      ? {
          ...value,
          text: `${value.text} · ${verdictWords(verdict, t)}`,
          role: value.role === "err" ? "err" : VERDICT_ROLE[verdict.says],
        }
      : value;
  switch (state.state) {
    case "ready":
      return cutOff({
        text: t("services", "readyOf", {
          ready: state.ready,
          total: state.total,
        }),
        role: "ok",
      });
    case "short": {
      const count = t("services", "readyOf", {
        ready: state.ready,
        total: state.total,
      });
      if (!state.rollout) return cutOff({ text: count, role: "warn" });
      const verdict = rolloutVerdict(state.rollout, t);
      return cutOff({ ...verdict, text: `${verdict.text} · ${count}` });
    }
    case "gone":
      return { text: t("services", "gone"), role: "err" };
    case "reading":
      return { text: t("services", "reading"), quiet: true };
    case "unread":
      return { text: t("services", "couldNotRead"), quiet: true };
  }
}

/**
 * What one pinned service's card draws, as the same five answers: state, the
 * ways in, the last change, what this app is waiting on, what it never read.
 * A neighbourhood this app could not read at all leaves the section `unread`
 * rather than drawing the rest of the card's empty defaults as fact.
 */
export function pinShare(
  pin: ServicePin,
  state: ServiceState,
  ways: { entries: EntryPoint[]; known: boolean },
  unread: readonly UnexploredKind[],
  latest: LastChange,
  waiting: readonly Watch[],
  t: T
): PlacedSection {
  const rows: { label: string; values: ReportValue[] }[] = [
    {
      label: t("columns", "name"),
      values: [{ text: pin.name, ref: refOf(pin) }],
    },
    {
      label: t("columns", "status"),
      values: [stateValue(state, waysVerdict(ways), t)],
    },
    {
      label: t("services", "wayIn"),
      values: [
        {
          text: !ways.known
            ? t("services", "notReadYet")
            : ways.entries.length === 0
              ? t("services", "nothingPublishes")
              : ways.entries.map((way) => wayWords(way, t)).join(", "),
        },
      ],
    },
    {
      label: t("services", "lastChange"),
      values: [
        {
          text: lastChangeWords(latest, t, utcMoment),
        },
      ],
    },
    ...(waiting.length > 0
      ? [
          {
            label: t("services", "waitingOn"),
            values: [
              {
                text: waiting
                  .map((watch) => t("tell", ASK_SHORT[watch.ask]))
                  .join(", "),
              },
            ],
          },
        ]
      : []),
    ...(unread.length > 0
      ? [
          {
            label: t("services", "notLookedAt"),
            values: [
              { text: unread.map((kind) => kind.kind).join(", "), quiet: true },
            ],
          },
        ]
      : []),
  ];
  return {
    id: `pin:${pinKey(pin)}`,
    order: ORDER.own,
    title: pin.name,
    icon: iconSvg(Pin),
    unread:
      state.state === "unread"
        ? state.why || t("services", "couldNotRead")
        : null,
    body: { type: "facts", rows },
  };
}
