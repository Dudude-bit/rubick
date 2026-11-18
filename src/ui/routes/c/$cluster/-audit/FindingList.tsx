import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, EyeOff } from "lucide-react";

import type {
  AuditFinding,
  AuditSeverity,
  ObjectAudit,
  RuleId,
  Subject,
  Unchecked,
  What,
} from "@/generated/types";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { parts } from "@/i18n/parts";
import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";
import { fixYaml } from "./fix-yaml";
import {
  CATEGORY_WORDS,
  RULE_META,
  SEVERITY_TONE,
  SEVERITY_WORDS,
  VERBATIM,
  ruleTitle,
  ruleWhy,
  said,
  standardWords,
  uncheckedWords,
} from "./rules";

const TONE_CLASS: Record<ReturnType<typeof toneOf>, string> = {
  err: "bg-err/16 text-err",
  warn: "bg-warn/16 text-warn",
  info: "bg-info/16 text-info",
};

const toneOf = (severity: AuditSeverity) => SEVERITY_TONE[severity];

export function SeverityBadge({ severity }: { severity: AuditSeverity }) {
  const t = useT();
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 text-[11px] font-medium leading-4",
        TONE_CLASS[toneOf(severity)]
      )}
    >
      {t("audit", SEVERITY_WORDS[severity])}
    </span>
  );
}

/** One value of a finding, the object's own words drawn as such. */
export function WhatLine({ what }: { what: What }) {
  const t = useT();
  const { key, values } = said(what, t);
  const shown: Record<string, string | number> = {};
  const verbatim: Record<string, ReactNode> = {};
  for (const [name, value] of Object.entries(values)) {
    if (VERBATIM.has(name))
      verbatim[name] = (
        <code className="font-mono text-[11px] text-fg">{String(value)}</code>
      );
    else shown[name] = value;
  }
  return <>{parts(t("audit", key, shown), verbatim)}</>;
}

/** Why it matters, how to fix it, and the fix to copy. */
export function RuleExplained({
  rule,
  kind,
  finding,
  subject,
}: {
  rule: RuleId;
  kind: string;
  finding?: AuditFinding;
  /** The object the finding is in, where one is: a release's fix names it. */
  subject?: Subject;
}) {
  const t = useT();
  const copy = useCopyToClipboard();
  const yaml = fixYaml(rule, kind, finding, subject);
  return (
    <div className="flex flex-col gap-2 text-xs">
      <div>
        <div className="mb-0.5 text-[11px] font-medium text-fg-mut">
          {t("audit", "why")}
        </div>
        <p className="text-fg">{ruleWhy(rule, t)}</p>
      </div>
      <div>
        <div className="mb-0.5 flex items-center gap-2 text-[11px] font-medium text-fg-mut">
          {t("audit", "fix")}
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 text-[11px]"
            onClick={() => void copy(yaml)}
          >
            {t("audit", "copyFix")}
          </Button>
        </div>
        <pre className="overflow-x-auto rounded border border-hair bg-raise p-2 font-mono text-[11px] text-fg">
          {yaml}
        </pre>
      </div>
    </div>
  );
}

/** The rule's title with its category and standard, as a row heading. */
export function RuleHeading({
  rule,
  severity,
  showTitle = true,
  children,
}: {
  rule: RuleId;
  severity: AuditSeverity;
  /** Off under a heading that already names the rule. */
  showTitle?: boolean;
  children?: ReactNode;
}) {
  const t = useT();
  const meta = RULE_META[rule];
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
      <SeverityBadge severity={severity} />
      {showTitle && (
        <span className="font-medium text-fg">{ruleTitle(rule, t)}</span>
      )}
      <span className="text-[11px] text-fg-fnt">
        {t("audit", CATEGORY_WORDS[meta.category])}
        {meta.standard && ` · ${standardWords(rule, t)}`}
      </span>
      {children}
    </span>
  );
}

function FindingRow({
  finding,
  subject,
  open,
  onToggle,
}: {
  finding: AuditFinding;
  subject: Subject;
  open: boolean;
  onToggle: () => void;
}) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li className="flex flex-col gap-1 py-1.5" data-rule={finding.rule}>
      <button
        type="button"
        className="flex items-start gap-1 text-left text-xs"
        aria-expanded={open}
        onClick={onToggle}
      >
        <Chevron className="mt-0.5 h-3 w-3 flex-none text-fg-fnt" aria-hidden />
        <RuleHeading rule={finding.rule} severity={finding.severity} />
      </button>
      <ul className="ml-4 flex flex-col gap-0.5 text-xs text-fg-mut">
        {finding.what.map((what, at) => (
          <li key={at}>
            <WhatLine what={what} />
          </li>
        ))}
      </ul>
      {open && (
        <div className="ml-4">
          <RuleExplained
            rule={finding.rule}
            kind={subject.kind}
            finding={finding}
            subject={subject}
          />
        </div>
      )}
    </li>
  );
}

/** The rules one object could not be answered for, and the read each waited on. */
export function UncheckedList({ unchecked }: { unchecked: Unchecked[] }) {
  const t = useT();
  if (unchecked.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5 pt-1 text-xs">
      <div className="flex items-center gap-1 text-[11px] font-medium text-fg-mut">
        <EyeOff className="h-3 w-3" aria-hidden />
        {t("audit", "notCheckedHere")}
      </div>
      <ul className="ml-4 flex flex-col gap-0.5 text-fg-mut">
        {unchecked.map((each) => (
          <li key={`${each.rule}/${each.kind}`} data-unchecked={each.rule}>
            {ruleTitle(each.rule, t)}: {uncheckedWords(each, t)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** How many rules could not answer here, where a peek has no room to list them. */
function UncheckedCount({ unchecked }: { unchecked: Unchecked[] }) {
  const t = useT();
  const rules = new Set(unchecked.map((each) => each.rule)).size;
  if (rules === 0) return null;
  return (
    <p
      className="flex items-center gap-1 py-1 text-[11px] text-fg-mut"
      data-testid="audit-unchecked-count"
    >
      <EyeOff className="h-3 w-3" aria-hidden />
      {t("audit", "peekUnchecked", { n: rules })}
    </p>
  );
}

/**
 * One object's findings, worst first, each opening to why and how; then
 * the rules that could not answer for it. `limit` cuts a peek's list,
 * says how many more the tab holds, and counts the rules unanswered.
 */
export function FindingList({
  audit,
  limit,
}: {
  audit: ObjectAudit;
  limit?: number;
}) {
  const t = useT();
  const [open, setOpen] = useState<RuleId | null>(null);
  const shown =
    limit === undefined ? audit.findings : audit.findings.slice(0, limit);
  const more = audit.findings.length - shown.length;
  return (
    <div className="flex flex-col">
      {audit.findings.length === 0 && (
        <p className="py-1 text-xs text-fg-mut">
          {t("audit", audit.unchecked.length > 0 ? "tabNonePartly" : "tabNone")}
        </p>
      )}
      <ul className="flex flex-col divide-y divide-hair">
        {shown.map((finding) => (
          <FindingRow
            key={finding.rule}
            finding={finding}
            subject={audit.subject}
            open={open === finding.rule}
            onToggle={() =>
              setOpen((was) => (was === finding.rule ? null : finding.rule))
            }
          />
        ))}
      </ul>
      {more > 0 && (
        <p className="py-1 text-[11px] text-fg-fnt">
          {t("audit", "peekMore", { n: more })}
        </p>
      )}
      {limit === undefined ? (
        <UncheckedList unchecked={audit.unchecked} />
      ) : (
        <UncheckedCount unchecked={audit.unchecked} />
      )}
    </div>
  );
}
