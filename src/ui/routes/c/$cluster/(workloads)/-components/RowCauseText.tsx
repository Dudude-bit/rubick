import type { ReactNode } from "react";

import { useT } from "@/i18n/useT";
import { podsShare } from "@/lib/pod-cause";
import { CauseLine } from "../../-object/CauseLine";
import { rowCauseText, type RowCause, type RowVerdict } from "./row-cause";

/** The cause a row's pods share, after its verdict, drawn as the Overview and the page draw it. */
export function RowCauseText({
  cause,
  verdict,
}: {
  cause: RowCause;
  verdict: RowVerdict;
}) {
  const t = useT();
  const text = rowCauseText(cause, verdict, t);
  if (!text) return null;
  if (cause.says !== "read" || !cause.shared)
    return <span className="min-w-0 truncate text-xs text-fg-fnt">{text}</span>;
  const { shared } = cause;
  return (
    <span
      className="min-w-0 truncate text-xs"
      title={text}
      data-testid="row-cause"
    >
      <span className="text-fg-mut">
        {podsShare(shared.pods, shared.of, t)}{" "}
      </span>
      <CauseLine cause={shared.cause} compact />
    </span>
  );
}

/** A verdict's badge with the cause beside it, the badge kept whole. */
export function VerdictWithCause({
  children,
  cause,
  verdict,
}: {
  children: ReactNode;
  cause: RowCause;
  verdict: RowVerdict;
}) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-baseline gap-1.5">
      <span className="flex-none">{children}</span>
      <RowCauseText cause={cause} verdict={verdict} />
    </span>
  );
}
