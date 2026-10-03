import { Pin } from "lucide-react";

import { journalWords, type JournalEntry } from "@/lib/changes";
import { iconSvg } from "@/lib/icon-svg";
import type { ReportValue } from "@/lib/report";
import { ORDER, refOf, type PlacedSection } from "@/lib/report-parts";
import {
  pinKey,
  type EntryPoint,
  type ServicePin,
  type ServiceState,
} from "@/lib/my-services";
import { ASK_SHORT, type Watch } from "@/lib/tell-me-when";
import type { T } from "@/i18n/useT";
import type { UnexploredKind } from "@/generated/types";

function stateValue(state: ServiceState, t: T): ReportValue {
  switch (state.state) {
    case "ready":
      return {
        text: t("services", "readyOf", {
          ready: state.ready,
          total: state.total,
        }),
        role: "ok",
      };
    case "short":
      return {
        text: t("services", "readyOf", {
          ready: state.ready,
          total: state.total,
        }),
        role: "warn",
      };
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
  latest: JournalEntry | null,
  waiting: readonly Watch[],
  t: T
): PlacedSection {
  const rows: { label: string; values: ReportValue[] }[] = [
    {
      label: t("columns", "name"),
      values: [{ text: pin.name, ref: refOf(pin) }],
    },
    { label: t("columns", "status"), values: [stateValue(state, t)] },
    {
      label: t("services", "wayIn"),
      values: [
        {
          text: !ways.known
            ? t("services", "notReadYet")
            : ways.entries.length === 0
              ? t("services", "nothingPublishes")
              : ways.entries.map((way) => way.url ?? way.label).join(", "),
        },
      ],
    },
    {
      label: t("services", "lastChange"),
      values: [
        {
          text: latest ? journalWords(latest, t) : t("services", "nothingSeen"),
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
