import type { T } from "@/i18n/useT";
import type { RuleRow } from "./model";

/** The page's headline while something fires: each count takes its own
 *  plural, or "1 rule objects" follows the number of alerts. */
export function firingWords(alerts: number, objects: number, t: T): string {
  return t("alerts", "firingNow", {
    n: alerts,
    where: t("alerts", "inRuleObjects", { n: objects }),
  });
}

/** The row's answer in a few words. */
export function rowWords(row: RuleRow, t: T): string {
  const worst = row.findings[0];
  switch (worst?.kind) {
    case "firing":
      return t("alerts", "rowFiring", { n: worst.alerts });
    case "notPickedUp":
      return t("monitors", "rowNotPickedUp");
    case "notLoaded":
      return t("alerts", "rowNotLoaded");
    case "partlyLoaded":
      return t("alerts", "rowPartlyLoaded", { n: worst.missing.length });
    case "evalError":
      return t("alerts", "rowEvalError");
    case "notEvaluated":
      return t("alerts", "rowNotEvaluated");
    case "pending":
      return t("alerts", "rowPending", { n: worst.alerts });
    case "pickedUpUnknown":
      return t("monitors", "rowUnknown");
  }
  if (row.loaded.state !== "read") return t("monitors", "rowNotChecked");
  if (row.object.rules.length === 0) return t("alerts", "rowRecordingOnly");
  return t("alerts", "rowQuiet", { n: row.object.rules.length });
}
