import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A stream that stopped on its own, as a bar above the output it left: the
 * headline in the tone of the failure, the cluster's own words beneath it,
 * and the way out on the right. Logs and the pod shell draw it the same way.
 */
export function StreamFailure({
  tone,
  headline,
  detail,
  children,
  action,
  testId,
}: {
  tone: "err" | "warn";
  headline: ReactNode;
  /** What the cluster said, in its own words. */
  detail?: ReactNode;
  /** Further lines under the detail. */
  children?: ReactNode;
  /** The way out; absent where there is none. */
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className="flex flex-none items-start justify-between gap-3 border-b border-hair px-3 py-1.5"
    >
      <div className="min-w-0">
        <p className={cn("text-xs", tone === "err" ? "text-err" : "text-warn")}>
          {headline}
        </p>
        {detail && (
          <p className="mt-0.5 wrap-break-word text-caption text-fg-mut">
            {detail}
          </p>
        )}
        {children}
      </div>
      {action}
    </div>
  );
}
