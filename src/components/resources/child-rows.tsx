import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { statusRole, type StatusRole } from "@/lib/status-role";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { ResourceType } from "@/lib/resource-registry";
import { cn, formatDate } from "@/lib/utils";
import { useRealtimeAge } from "@/hooks/useRealtimeAge";
import type { JobInfo } from "@/generated/types";

/**
 * The objects a workload owns, listed on its detail page.
 *
 * The same shape as the overview's node list: a dot for the state, the name,
 * the one count that says whether it is doing its job, and an age. The state
 * word is always present — the dot is a second reading of it, never the only
 * one.
 */

export interface ChildRow {
  name: string;
  href: string;
  /** Raw status word from the API, shown as-is beside the name. */
  status: string;
  /** Right-aligned facts: readiness, restarts, completions. */
  detail?: ReactNode;
  timestamp?: string | null;
}

const DOT: Record<StatusRole, string> = {
  ok: "bg-ok",
  pending: "bg-warn",
  warn: "bg-warn",
  err: "bg-err",
  neutral: "bg-fg-fnt",
};

/** Only an abnormal state colours its word; running and completed stay quiet. */
const WORD: Record<StatusRole, string> = {
  ok: "text-fg-fnt",
  pending: "text-warn",
  warn: "text-warn",
  err: "text-err",
  neutral: "text-fg-fnt",
};

export function ChildRows({
  rows,
  emptyMessage = "Nothing here",
}: {
  rows: ChildRow[];
  emptyMessage?: string;
}) {
  if (rows.length === 0) {
    return <p className="px-1.5 py-1 text-xs text-fg-fnt">{emptyMessage}</p>;
  }
  return (
    <div>
      {rows.map((row) => (
        <ChildRowItem key={row.href} row={row} />
      ))}
    </div>
  );
}

function ChildRowItem({ row }: { row: ChildRow }) {
  const role = statusRole(row.status);
  const age = useRealtimeAge(row.timestamp ?? null);

  return (
    <Link
      to={row.href}
      className="grid grid-cols-[7px_minmax(0,1fr)_auto_44px] items-center gap-2.5 rounded-[5px] px-1.5 py-[5px] text-xs hover:bg-hover"
    >
      <span
        className={cn("h-[7px] w-[7px] rounded-full", DOT[role])}
        aria-hidden="true"
      />
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate font-mono text-fg-mid">{row.name}</span>
        <span className={cn("text-[11px]", WORD[role])}>{row.status}</span>
      </span>
      <span className="text-right text-[11px] text-fg-mut">{row.detail}</span>
      <span
        className="text-right text-[11px] text-fg-fnt"
        title={formatDate(row.timestamp ?? null) ?? undefined}
      >
        {row.timestamp ? age : "—"}
      </span>
    </Link>
  );
}

/** The Jobs a CronJob has spawned. */
export function JobRows({
  jobs,
  emptyMessage = "This CronJob has not run yet",
}: {
  jobs: JobInfo[];
  emptyMessage?: string;
}) {
  return (
    <ChildRows
      emptyMessage={emptyMessage}
      rows={jobs.map((job) => ({
        name: job.name,
        href: getResourceDetailUrl(ResourceType.Job, job.name, job.namespace),
        status: job.status || "Unknown",
        detail: (
          <>
            {job.succeeded}
            <span className="text-fg-fnt">/{job.completions ?? 1}</span>
            <span className="text-fg-fnt"> completed</span>
            {job.failed > 0 && (
              <span className="text-err"> · {job.failed} failed</span>
            )}
          </>
        ),
        timestamp: job.createdAt,
      }))}
    />
  );
}
