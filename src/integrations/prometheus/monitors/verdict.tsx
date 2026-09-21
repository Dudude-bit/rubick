import type { ReactNode } from "react";

import type { T } from "@/i18n/useT";
import type { MonitorRow } from "./model";
import { selectorWords } from "./model";

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * The sentence the card leads with. Exported for its own test: it is the
 * one place a monitor's whole state is reduced to a claim, and a kind of
 * finding with no arm here falls through to "up, nothing to do".
 */
export function verdictOf(
  row: MonitorRow,
  instanceCount: number,
  since: number | null,
  lastScrapeAgo: string | null,
  t: T
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
    case "notPickedUp":
      return instanceCount === 0
        ? { head: t("monitors", "verdictNoInstances"), body: null }
        : {
            head: t("monitors", "verdictNotPickedUp"),
            body: t("monitors", "notPickedUp"),
          };
    case "pickedUpUnknown":
      return {
        head: t("monitors", "verdictPickedUpUnknown"),
        body: worst.reason,
      };
    case "targetsDown":
      return {
        head:
          since !== null
            ? t("monitors", "verdictDownSince", {
                down: worst.down,
                total: worst.total,
                since: clock(since),
              })
            : t("monitors", "verdictDown", {
                down: worst.down,
                total: worst.total,
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
        head: t("monitors", "verdictNoTargets"),
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
  if (row.pickedUp.state === "noKind")
    return { head: t("monitors", "verdictNoKind"), body: null };
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
