import type { Finding, Severity } from "@/generated/types";
import { useT } from "@/i18n/useT";

/**
 * How far down the page a finding belongs.
 *
 * The rank is a promise about reading order: somebody who stops after the
 * first line should have read the thing that breaks a connection, not the
 * thing that dims a feature.
 */
const RANK: Record<Severity, number> = {
  blocking: 0,
  misconfigured: 1,
  unverified: 2,
  optional: 3,
};

/**
 * The first two stop something working; the last two do not, but one of
 * them says the verdicts above may be wrong. Total, so a severity the
 * backend learns to report has to be given a tone here.
 */
const TONE: Record<Severity, "text-err" | "text-warn"> = {
  blocking: "text-err",
  misconfigured: "text-err",
  unverified: "text-warn",
  optional: "text-warn",
};

export function FindingsList({ findings }: { findings: Finding[] }) {
  const t = useT();
  if (findings.length === 0) {
    return (
      <p className="max-w-[72ch] text-xs text-fg-mut">
        {t("settings", "diagnosticsAllClear")}
      </p>
    );
  }

  // Sorted here as well as in the backend: the panel must not depend on the
  // order a caller happened to send, and the tiebreak keeps two reads of an
  // unchanged machine looking identical.
  const ordered = [...findings].sort(
    (a, b) =>
      RANK[a.severity] - RANK[b.severity] ||
      (a.subject ?? "").localeCompare(b.subject ?? "")
  );

  return (
    <ul className="space-y-3">
      {ordered.map((finding, i) => (
        <li key={`${finding.title}-${finding.subject ?? i}`}>
          <h4 className={`text-xs font-medium ${TONE[finding.severity]}`}>
            {finding.title}
          </h4>
          <p className="mt-1 max-w-[72ch] text-xs text-fg-mut">
            {finding.detail}
          </p>
        </li>
      ))}
    </ul>
  );
}
