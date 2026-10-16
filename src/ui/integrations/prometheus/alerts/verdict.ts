/**
 * The sentence the Alerts card leads with.
 *
 * Its own file, as the monitors' verdict is: inside the page component it
 * was reachable by no test, and the two "not checked" arms — the ones that
 * keep an unread Prometheus from getting the quiet verdict — could both be
 * deleted with the whole suite green.
 */
import type { T } from "@/i18n/useT";
import { unknowableWords } from "../monitors/words";
import type { RuleRow } from "./model";

export function verdictOf(
  row: RuleRow,
  instanceCount: number,
  t: T
): { head: string; body: string | null } {
  const worst = row.findings[0];
  switch (worst?.kind) {
    case "firing":
      return {
        head: t("alerts", "verdictFiring", {
          n: worst.alerts,
          from: t("alerts", "fromRules", { n: worst.rules }),
        }),
        body: null,
      };
    case "notPickedUp":
      return instanceCount === 0
        ? { head: t("monitors", "verdictNoInstances"), body: null }
        : {
            head: t("alerts", "verdictNotPickedUp"),
            body: t("alerts", "notPickedUp"),
          };
    case "notLoaded":
      return {
        head: t("alerts", "verdictNotLoaded"),
        body: t("alerts", "notLoaded"),
      };
    case "partlyLoaded":
      return {
        head: t("alerts", "verdictPartlyLoaded", { n: worst.missing.length }),
        body: worst.missing.join(", "),
      };
    case "evalError":
      return {
        head: t("alerts", "verdictEvalError", { rule: worst.rule }),
        body: worst.lastError,
      };
    case "notEvaluated":
      return {
        head: t("alerts", "verdictNotEvaluated", { rule: worst.rule }),
        body: t("alerts", "notEvaluated"),
      };
    case "pending":
      return {
        head: t("alerts", "verdictPending", {
          n: worst.alerts,
          from: t("alerts", "fromRules", { n: worst.rules }),
        }),
        body: null,
      };
    case "pickedUpUnknown":
      return {
        head: t("monitors", "verdictPickedUpUnknown"),
        body:
          worst.why.kind === "unread"
            ? worst.why.reason
            : unknowableWords(worst.why, t),
      };
  }
  if (row.pickedUp.state === "noKind")
    return { head: t("monitors", "verdictNoKind"), body: null };
  if (row.loaded.state === "notConnected")
    return {
      head: t("alerts", "verdictNotChecked"),
      body: t("alerts", "notConnected"),
    };
  if (row.loaded.state === "unanswered")
    return {
      head: t("alerts", "verdictNotChecked"),
      body: t("alerts", "unanswered", { reason: row.loaded.reason }),
    };
  return {
    head: t("alerts", "verdictQuiet", { n: row.object.rules.length }),
    body: t("monitors", "nothingToDo"),
  };
}
