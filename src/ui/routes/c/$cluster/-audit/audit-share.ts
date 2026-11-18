import { ShieldCheck } from "lucide-react";

import type {
  AuditPage,
  AuditQuery,
  AuditSeverity,
  Grouping,
  ObjectAudit,
  Subject,
} from "@/generated/types";
import type { T } from "@/i18n/useT";
import { errorToShow } from "@/lib/error-utils";
import { iconSvg } from "@/lib/icon-svg";
import { formatWhen } from "@/lib/utils";
import type { ReportFinding } from "@/lib/report";
import { ORDER, refOf, type PlacedSection } from "@/lib/report-parts";
import type { StatusRole } from "@/lib/status-role";
import {
  anythingUnread,
  checkedWords,
  notCheckedWords,
  upgradeWords,
  usageWords,
} from "./summary-words";
import {
  CATEGORY_WORDS,
  SEVERITY_WORDS,
  ruleTitle,
  uncheckedWords,
  whatWords,
} from "./rules";
import { kindWords } from "./subjects";

/** A subject's reference in the file: a Helm release named in words, as on screen. */
const subjectRef = (subject: Subject, t: T) =>
  refOf({ ...subject, kind: kindWords(subject.kind, t) });

const ROLE: Record<AuditSeverity, StatusRole> = {
  high: "err",
  medium: "warn",
  low: "neutral",
};

/** The filters a page's rows were narrowed by, in words; `null` for every row. */
export function filterWords(query: AuditQuery, t: T): string | null {
  const filters = [
    ...query.severities.map((severity) => t("audit", SEVERITY_WORDS[severity])),
    ...query.categories.map((category) => t("audit", CATEGORY_WORDS[category])),
    ...query.rules.map((rule) => ruleTitle(rule, t)),
  ];
  return filters.length > 0
    ? t("audit", "sharedOnly", { filters: filters.join(", ") })
    : null;
}

/** Everything the screen says was not read, or not read whole, in its words. */
function unreadWords(page: AuditPage, t: T): string[] {
  const { summary } = page;
  const unchecked = summary.rules.filter((rule) => rule.unchecked > 0).length;
  return [
    ...summary.notChecked.map((each) => notCheckedWords(each, t)),
    ...summary.late.map((late) =>
      t("audit", "late", {
        kind: late.kind,
        where: late.namespace
          ? t("audit", "lateIn", { namespace: late.namespace })
          : t("audit", "lateAcross"),
        since: formatWhen(late.since, "moment"),
      })
    ),
    ...(summary.reading > 0
      ? [t("audit", "reading", { n: summary.reading })]
      : []),
    ...(summary.unattributed > 0
      ? [t("audit", "unattributed", { n: summary.unattributed })]
      : []),
    ...(unchecked > 0 ? [t("audit", "rulesUnchecked", { n: unchecked })] : []),
    ...(summary.upgrade.read === null ? [upgradeWords(page, t)] : []),
    ...(summary.usage !== null && summary.usage.says !== "read"
      ? [usageWords(page, t) ?? ""]
      : []),
  ];
}

/**
 * The Audit page in a shared file: the rows the screen shows, the scope's
 * counts, and every kind that was not read, said where the counts are, so a
 * file with no findings in it is never read as a clean bill.
 */
export function auditScreenSection(
  page: AuditPage,
  view: Grouping,
  t: T,
  narrowed: string | null = null
): PlacedSection {
  const items: ReportFinding[] = page.rows.flatMap((row): ReportFinding[] => {
    switch (row.row) {
      case "rule": {
        const unchecked =
          row.unchecked > 0
            ? t("audit", "uncheckedOf", { n: row.unchecked })
            : null;
        return [
          row.worst === null
            ? {
                title: ruleTitle(row.rule, t),
                detail: unchecked,
                role: "neutral",
                mark: "notRead",
              }
            : {
                title: `${t("audit", SEVERITY_WORDS[row.worst])} · ${ruleTitle(row.rule, t)}`,
                detail: [t("audit", "objectsOf", { n: row.objects }), unchecked]
                  .filter(Boolean)
                  .join(" · "),
                role: ROLE[row.worst],
              },
        ];
      }
      case "object":
        return [
          {
            title: row.rules.map((rule) => ruleTitle(rule, t)).join(", "),
            detail: null,
            role: row.worst ? ROLE[row.worst] : "neutral",
            ref: subjectRef(row.subject, t),
            ...(row.worst === null ? { mark: "notRead" as const } : {}),
          },
        ];
      case "found":
        return [
          {
            title: ruleTitle(row.finding.rule, t),
            detail: row.finding.what
              .map((what) => whatWords(what, t))
              .join("; "),
            role: ROLE[row.finding.severity],
            ref: subjectRef(row.subject, t),
          },
        ];
      case "blind":
        return [
          {
            title: ruleTitle(row.unchecked.rule, t),
            detail: uncheckedWords(row.unchecked, t),
            role: "neutral",
            ref: subjectRef(row.subject, t),
            mark: "notRead",
          },
        ];
    }
  });
  const unread = unreadWords(page, t);
  return {
    id: "audit",
    order: ORDER.own,
    title: t("audit", view === "rule" ? "byRule" : "byObject"),
    icon: iconSvg(ShieldCheck),
    count: unread.length > 0 || anythingUnread(page) ? null : page.total,
    partial: unread.join("; ") || null,
    caption: [narrowed, checkedWords(page, t)].filter(Boolean).join(" "),
    body: { type: "findings", items },
    notRead: unread,
  };
}

/** One object's findings in its page's shared file: the tab's own answer. */
export function auditObjectSection(
  audit: ObjectAudit | undefined,
  error: unknown,
  t: T
): PlacedSection {
  const items: ReportFinding[] = (audit?.findings ?? []).map((finding) => ({
    title: `${t("audit", SEVERITY_WORDS[finding.severity])} · ${ruleTitle(finding.rule, t)}`,
    detail: finding.what.map((what) => whatWords(what, t)).join("; "),
    role: ROLE[finding.severity],
  }));
  const blind: ReportFinding[] = (audit?.unchecked ?? []).map((each) => ({
    title: ruleTitle(each.rule, t),
    detail: uncheckedWords(each, t),
    role: "neutral",
    mark: "notRead",
  }));
  const judgedOn = audit?.judgedOn;
  const section = {
    id: "audit",
    order: ORDER.own,
    title: t("audit", "tab"),
    icon: iconSvg(ShieldCheck),
    unread: error ? errorToShow(error) : null,
  };
  // Judged on its workload, the object has no answer of its own to count:
  // an empty list would read as a clean one.
  if (judgedOn)
    return {
      ...section,
      count: null,
      body: {
        type: "text",
        text: t("audit", "judgedOn", {
          kind: audit.subject.kind,
          object: `${judgedOn.kind} ${judgedOn.name}`,
        }),
      },
    };
  return {
    ...section,
    count: audit && audit.unchecked.length === 0 ? audit.findings.length : null,
    body: { type: "findings", items: [...items, ...blind] },
  };
}

/** What a page holds of its Audit tab's answer. */
export interface AuditRead {
  data: ObjectAudit | undefined;
  error: unknown;
}

/** The Audit tab's section for an object's file, where the page reads one. */
export function auditSections(
  audit: AuditRead | undefined,
  t: T
): PlacedSection[] {
  if (!audit || (!audit.data && !audit.error)) return [];
  return [auditObjectSection(audit.data, audit.error, t)];
}
