import { ShieldCheck } from "lucide-react";

import type { ObjectAudit } from "@/generated/types";
import {
  countMark,
  severityMark,
  viewGlyph,
  type DetailTab,
  type DetailTabMark,
} from "@/components/object/detail-tab";
import { Section, SectionHeader } from "@/components/ui/section";
import type { T } from "@/i18n/useT";
import { AuditBody } from "./PeekAudit";
import { SEVERITY_TONE, SEVERITY_WORDS } from "./rules";
import type { ObjectAuditQuery } from "./useAudit";

/**
 * The tab's mark, from the same answer as its body: the worst finding's
 * tone, a not-checked mark where a rule could not answer and nothing was
 * found, else the count.
 */
export function auditMark(
  audit: ObjectAudit | undefined,
  error: unknown,
  t: T
): DetailTabMark | null {
  if (error) return { shows: "unchecked", says: t("audit", "notCheckedHere") };
  if (!audit || audit.judgedOn) return null;
  const worst = audit.findings[0]?.severity;
  if (worst && worst !== "low")
    return severityMark(
      SEVERITY_TONE[worst],
      t("audit", SEVERITY_WORDS[worst])
    );
  if (audit.findings.length === 0 && audit.unchecked.length > 0)
    return { shows: "unchecked", says: t("audit", "notCheckedHere") };
  return audit.findings.length > 0 ? countMark(audit.findings.length) : null;
}

/** A workload's or pod's Audit tab; its mark and its body read one answer. */
export function auditTab(query: ObjectAuditQuery, t: T): DetailTab {
  return {
    id: "audit",
    label: t("audit", "tab"),
    glyph: viewGlyph(ShieldCheck),
    mark: auditMark(query.data, query.error, t),
    content: (
      <Section>
        <SectionHeader
          title={t("audit", "tab")}
          count={
            query.data && !query.data.judgedOn && query.data.findings.length > 0
              ? t("audit", "findingsOf", { n: query.data.findings.length })
              : undefined
          }
          description={t("audit", "caption")}
        />
        <AuditBody query={query} />
      </Section>
    ),
  };
}
