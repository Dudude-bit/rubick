import type { AuditPage, NotChecked } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { formatWhen } from "@/lib/utils";
import { whyWords } from "./rules";
import { kindWords } from "./subjects";

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
        t("audit", "checkedKind", {
          kind: kindWords(kind.kind, t, true),
          n: kind.objects,
        })
      )
      .join(", "),
  });
}

/** Whether anything in the scope went unread, so "nothing found" is not the whole answer. */
export const anythingUnread = (page: AuditPage) =>
  page.summary.notChecked.length > 0 ||
  page.summary.reading > 0 ||
  page.summary.unattributed > 0 ||
  page.summary.upgrade.read === null;

/** When the upgrade rules last read, against which Kubernetes, or that they still are. */
export function upgradeWords(page: AuditPage, t: T): string {
  const { read, server } = page.summary.upgrade;
  if (read === null) return t("audit", "upgradeReading");
  const time = formatWhen(read, "moment");
  return server === null
    ? t("audit", "upgradeReadUnversioned", { time })
    : t("audit", "upgradeRead", { time, server });
}
