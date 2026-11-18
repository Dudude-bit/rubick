import { ResourceRef } from "@/components/object/ResourceRef";
import { Unknown } from "@/components/ui/unknown";
import type { ObjectAudit } from "@/generated/types";
import { parts } from "@/i18n/parts";
import { useT } from "@/i18n/useT";
import { PeekHeading } from "../-peek/peek-heading";
import { FindingList } from "./FindingList";
import type { ObjectAuditQuery } from "./useAudit";

/** "This Pod's template is judged as part of Deployment web", the workload linked. */
function JudgedOn({ audit }: { audit: ObjectAudit }) {
  const t = useT();
  const on = audit.judgedOn;
  if (!on) return null;
  return (
    <p className="py-1 text-xs text-fg-mut" data-testid="audit-judged-on">
      {parts(t("audit", "judgedOn", { kind: audit.subject.kind }), {
        object: (
          <ResourceRef
            kind={on.kind}
            name={on.name}
            namespace={on.namespace ?? undefined}
          />
        ),
      })}
    </p>
  );
}

export function AuditBody({
  query,
  compact,
}: {
  query: ObjectAuditQuery;
  compact?: number;
}) {
  const t = useT();
  if (query.error)
    return (
      <Unknown
        question={t("audit", "tab")}
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    );
  if (!query.data)
    return (
      <p className="py-1 text-xs text-fg-fnt">{t("audit", "whyReading")}</p>
    );
  if (query.data.judgedOn) return <JudgedOn audit={query.data} />;
  return <FindingList audit={query.data} limit={compact} />;
}

/** The peek's Audit group: the worst few, and how many more the tab holds. */
export function PeekAudit({ query }: { query: ObjectAuditQuery }) {
  const t = useT();
  const audit = query.data;
  if (
    !query.error &&
    (!audit ||
      (!audit.judgedOn &&
        audit.findings.length === 0 &&
        audit.unchecked.length === 0))
  )
    return null;
  return (
    <div className="mt-3" data-testid="peek-audit">
      <PeekHeading
        title={t("audit", "tab")}
        count={
          audit && !audit.judgedOn && audit.findings.length > 0
            ? audit.findings.length
            : undefined
        }
      />
      <AuditBody query={query} compact={5} />
    </div>
  );
}
