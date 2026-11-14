import type { AuditPage, NotChecked } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { whyWords } from "./rules";

/** "PodDisruptionBudget in shop: refused: …", or across the cluster. */
export function notCheckedWords(each: NotChecked, t: T): string {
  return each.namespace
    ? t("audit", "notCheckedIn", {
        kind: each.kind,
        namespace: each.namespace,
        why: whyWords(each.why, t),
      })
    : t("audit", "notCheckedAcross", {
        kind: each.kind,
        why: whyWords(each.why, t),
      });
}

/** "Deployment 120, StatefulSet 4, ConfigMap 380": what was judged, by kind. */
export function checkedWords(page: AuditPage, t: T): string {
  return t("audit", "checked", {
    list: page.summary.checked
      .map((kind) =>
        t("audit", "checkedKind", { kind: kind.kind, n: kind.objects })
      )
      .join(", "),
  });
}

/** Whether anything in the scope went unread, so "nothing found" is not the whole answer. */
export const anythingUnread = (page: AuditPage) =>
  page.summary.notChecked.length > 0 ||
  page.summary.reading > 0 ||
  page.summary.unattributed > 0;
