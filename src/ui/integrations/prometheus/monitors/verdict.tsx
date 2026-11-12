import type { ReactNode } from "react";

import type { T } from "@/i18n/useT";
import type { MonitorRow } from "./model";
import { selectorWords } from "./model";
import { NOT_JUDGED, unknowableWords } from "./words";
import { hourMinute } from "../../kit";

/**
 * The sentence the card leads with. Exported for its own test: it is the
 * one place a monitor's whole state is reduced to a claim, and a kind of
 * finding with no arm here falls through to "up, nothing to do".
 */
export function verdictOf(
  row: MonitorRow,
  since: number | null,
  lastScrapeAgo: string | null,
  t: T,
  /** The reader's clock on the page; a shared file speaks UTC. */
  clock: (at: number) => string = hourMinute
): { head: string; body: ReactNode } {
  const worst = row.findings[0];
  const { scrape } = row;
  switch (worst?.kind) {
    case "selectsNothing":
      return {
        head: t("monitors", "verdictSelectsNothing"),
        body: t("monitors", "verdictSelectsNothingBody", {
          selector: selectorWords(row.monitor.selector) || "{}",
          namespace: row.monitor.namespace,
        }),
      };
    case "selectionUnread":
      return {
        head: t("monitors", "verdictSelectionUnread"),
        body: worst.reason,
      };
    case "selectorUnevaluable":
      return {
        head: t("monitors", "verdictSelectorUnevaluable"),
        body: t("monitors", "selectorUnevaluable", {
          selector: selectorWords(row.monitor.selector) || "{}",
        }),
      };
    case "notPickedUp":
      return {
        head: t("monitors", "verdictNotPickedUp"),
        body: t("monitors", "notPickedUp"),
      };
    case "pickedUpUnknown":
      return {
        head: t("monitors", "verdictPickedUpUnknown"),
        body:
          worst.why.kind === "unread"
            ? worst.why.reason
            : unknowableWords(worst.why, t),
      };
    case "targetsDown":
      return {
        head:
          since !== null
            ? t("monitors", "verdictDownSince", {
                down: worst.down,
                of: t("monitors", "ofTargets", { n: worst.total }),
                since: clock(since),
              })
            : t("monitors", "verdictDown", {
                down: worst.down,
                of: t("monitors", "ofTargets", { n: worst.total }),
              }),
        body: worst.lastError ? (
          <>
            {t("monitors", "prometheusSays")}:{" "}
            <span className="select-text break-all font-mono text-[11.5px] text-fg-mid">
              {worst.lastError}
            </span>
          </>
        ) : null,
      };
    case "noTargets":
      return {
        // "Picked up" is not ours to say where pick-up was not judged.
        head:
          row.pickedUp.state === "notJudged"
            ? t("monitors", NOT_JUDGED[row.pickedUp.lacks].verdict)
            : t("monitors", "verdictNoTargets"),
        body: t("monitors", "noTargets"),
      };
    // The arm that was missing. Without it a monitor whose targets are all
    // discovered-and-not-yet-scraped fell past the switch and past both
    // scrape guards onto the last return — "0 targets up, scraped ? ago"
    // and "Nothing to do here" — over a table saying the opposite two
    // lines below.
    case "targetsUnscraped":
      return {
        head: t("monitors", "verdictUnscraped", {
          n: worst.unknown,
          total: worst.total,
        }),
        body: t("monitors", "unscrapedSettles"),
      };
  }
  if (row.pickedUp.state === "notJudged")
    return {
      head: t("monitors", NOT_JUDGED[row.pickedUp.lacks].verdict),
      body: null,
    };
  if (scrape.state === "notConnected")
    return {
      head: t("monitors", "verdictNotChecked"),
      body: t("monitors", "notConnected"),
    };
  if (scrape.state === "unanswered")
    return {
      head: t("monitors", "verdictNotChecked"),
      body: t("monitors", "unanswered", { reason: scrape.reason }),
    };
  return {
    head: t("monitors", "verdictUp", {
      n: scrape.up,
      ago: lastScrapeAgo ?? "?",
    }),
    body: t("monitors", "nothingToDo"),
  };
}
