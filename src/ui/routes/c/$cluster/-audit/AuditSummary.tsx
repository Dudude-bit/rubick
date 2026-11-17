import { Clock, EyeOff, Info, ShieldAlert } from "lucide-react";

import type { AuditPage } from "@/generated/types";
import { useT } from "@/i18n/useT";
import { formatWhen } from "@/lib/utils";
import { CATEGORY_WORDS, RULE_IDS, ruleTitle } from "./rules";
import {
  anythingUnread,
  checkedWords,
  notCheckedWords,
  upgradeWords,
  usageWords,
} from "./summary-words";

/**
 * The scope's answer in a few lines: counts by severity and category, what
 * was checked, and, apart from it, what was not, each with the rules it
 * leaves unanswered. An empty answer says nothing was found only where
 * nothing went unread.
 */
export function AuditSummaryBlock({
  page,
  scope,
  system,
}: {
  page: AuditPage;
  /** The window's namespaces inside a sentence. */
  scope: string;
  system: boolean;
}) {
  const t = useT();
  const { summary } = page;
  const unread = anythingUnread(page);
  const refusedAcross = summary.notChecked.some(
    (each) => each.namespace === null && each.why.says === "refused"
  );
  return (
    <div
      className="flex flex-col gap-1 px-1.5 text-xs"
      data-testid="audit-summary"
    >
      {system && <p className="text-fg-mut">{t("audit", "systemShown")}</p>}
      {!system && (
        <p className="text-fg-mut">
          {(Object.keys(CATEGORY_WORDS) as (keyof typeof CATEGORY_WORDS)[])
            .map(
              (category) =>
                `${t("audit", CATEGORY_WORDS[category])} ${summary.categories[category]}`
            )
            .join(" · ")}
        </p>
      )}
      {summary.checked.length > 0 && (
        <p className="text-fg-mut">{checkedWords(page, t)}</p>
      )}
      <p
        className={summary.upgrade.read === null ? "text-warn" : "text-fg-fnt"}
        data-testid="audit-upgrade-read"
      >
        {upgradeWords(page, t)}
      </p>
      {summary.usage !== null && (
        <p
          className={
            summary.usage.says === "read" ? "text-fg-fnt" : "text-warn"
          }
          data-testid="audit-usage-read"
        >
          {usageWords(page, t)}
        </p>
      )}
      {summary.notChecked.length > 0 && (
        <div className="flex flex-col gap-0.5" data-testid="audit-not-checked">
          <span className="flex items-center gap-1 font-medium text-warn">
            <EyeOff className="h-3 w-3" aria-hidden />
            {t("audit", "notCheckedTitle")}
          </span>
          <ul className="ml-4 flex flex-col gap-0.5 text-fg-mut">
            {summary.notChecked.map((each) => (
              <li
                key={`${each.kind}/${each.namespace ?? ""}`}
                title={t("audit", "blinds", {
                  rules: each.rules
                    .map((rule) => ruleTitle(rule, t))
                    .join(", "),
                })}
              >
                {notCheckedWords(each, t)}
              </li>
            ))}
          </ul>
          {refusedAcross && (
            <p className="ml-4 text-fg-fnt">{t("audit", "pickNamespaces")}</p>
          )}
        </div>
      )}
      {summary.late.map((late) => (
        <p
          key={`late/${late.kind}/${late.namespace ?? ""}`}
          className="flex items-center gap-1 text-warn"
        >
          <Clock className="h-3 w-3" aria-hidden />
          {t("audit", "late", {
            kind: late.kind,
            where: late.namespace
              ? t("audit", "lateIn", { namespace: late.namespace })
              : t("audit", "lateAcross"),
            since: formatWhen(late.since, "moment"),
          })}
        </p>
      ))}
      {summary.reading > 0 && (
        <p className="text-fg-mut">
          {t("audit", "reading", { n: summary.reading })}
        </p>
      )}
      {summary.unattributed > 0 && (
        <p className="text-warn">
          {t("audit", "unattributed", { n: summary.unattributed })}
        </p>
      )}
      {summary.enforced.map((each) => (
        <p
          key={`enforced/${each.namespace}`}
          className="flex items-center gap-1 text-fg-fnt"
        >
          <ShieldAlert className="h-3 w-3" aria-hidden />
          {t("audit", "enforced", {
            namespace: each.namespace,
            level: each.level,
          })}
        </p>
      ))}
      {!system && summary.findings === 0 && (
        <p
          className="flex items-center gap-1 text-fg"
          data-testid="audit-nothing"
        >
          <Info className="h-3 w-3" aria-hidden />
          {unread
            ? t("audit", "nothingFoundPartly")
            : t("audit", "nothingFound", {
                scope,
                rules: t("audit", "rulesCount", { n: RULE_IDS.length }),
              })}
        </p>
      )}
    </div>
  );
}
