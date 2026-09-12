import type { T } from "@/i18n/useT";
import type { RuleRow } from "./model";

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
    case "pending":
      return t("alerts", "rowPending", { n: worst.alerts });
    case "pickedUpUnknown":
      return t("monitors", "rowUnknown");
  }
  if (row.loaded.state !== "read") return t("monitors", "rowNotChecked");
  return t("alerts", "rowQuiet", { n: row.object.rules.length });
}
