import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { ROLE_DOT, statusRole, type StatusRole } from "@/lib/status-role";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { ResourceType, type ResourceKind } from "@/lib/resource-registry";
import { cn, formatDate } from "@/lib/utils";
import { useRealtimeAge } from "@/hooks/useRealtimeAge";
import { ResourceRef } from "./ResourceRef";
import type { JobInfo, ReplicaSetInfo } from "@/generated/types";
import { T } from "@/i18n/T";
import { useT } from "@/i18n/useT";
import { isRefusal, verbatim } from "@/lib/error-utils";

/**
 * The objects a workload owns, listed on its detail page.
 *
 * The same shape as the overview's node list: a dot for the state, the name,
 * the one count that says whether it is doing its job, and an age. The state
 * word is always present — the dot is a second reading of it, never the only
 * one.
 */

export interface ChildRow {
  kind: ResourceKind;
  name: string;
  namespace?: string | null;
  /** Raw status word from the API, shown as-is beside the name. */
  status: string;
  /** Right-aligned facts: readiness, restarts, completions. */
  detail?: ReactNode;
  timestamp?: string | null;
}

/**
 * Only an abnormal state colours its word; running and completed stay quiet.
 * The dot is `ROLE_DOT`, shared — this file had its own copy in which
 * `pending` was amber while every other surface drew it blue, so one pod in
 * ContainerCreating looked like a different severity depending on which
 * screen you were on.
 */
const WORD: Record<StatusRole, string> = {
  ok: "text-fg-fnt",
  pending: "text-info",
  warn: "text-warn",
  err: "text-err",
  neutral: "text-fg-fnt",
};

export function ChildRows({
  rows,
  // A default is what most callers ship with, so it has to name a state
  // rather than shrug: "Nothing here" told the reader neither what was
  // looked for nor whether the lookup worked.
  emptyMessage,
  /**
   * The read failed, and there is nothing to show from before it.
   *
   * Without this the card had one story for two states: a workload with no
   * pods and a pod list nobody was allowed to read both rendered "no pods
   * for this workload". The second is a claim about the cluster made from a
   * question that was never answered — and it is the reading somebody takes
   * to mean their deployment is down. Same rule `ResourceList` follows: the
   * failure only replaces the rows when there are no rows left.
   */
  error,
  /** What was being listed, for the failure line. */
  label,
}: {
  rows: ChildRow[];
  emptyMessage?: string;
  error?: Error | null;
  label?: string;
}) {
  const t = useT();
  if (rows.length === 0 && error) {
    return (
      <div className="px-1.5 py-1">
        <p className="text-xs text-err">
          {/* A refusal is not a failure: saying "could not read" about one
              invites a retry that will be refused the same way. */}
          {isRefusal(error)
            ? t("nav", "noListAccess")
            : t("empty", "couldNotReadInScope", { label: label ?? "" })}
        </p>
        <p className="mt-1 select-text wrap-break-word font-mono text-[11px] text-fg-fnt">
          {verbatim(error.message)}
        </p>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="px-1.5 py-1 text-xs text-fg-fnt">
        {emptyMessage ?? <T section="empty" k="nothingBelongsToObject" />}
      </p>
    );
  }
  return (
    <div>
      {rows.map((row) => (
        <ChildRowItem key={`${row.namespace ?? ""}/${row.name}`} row={row} />
      ))}
    </div>
  );
}

function ChildRowItem({ row }: { row: ChildRow }) {
  const navigate = useNavigate();
  const role = statusRole(row.status);
  const age = useRealtimeAge(row.timestamp ?? null);

  return (
    // The row opens the page and the name opens the peek, which is the split
    // the resource tables already use — so the name has to keep its own click.
    <div
      role="link"
      tabIndex={0}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a")) return;
        navigate(getResourceDetailUrl(row.kind, row.name, row.namespace));
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        navigate(getResourceDetailUrl(row.kind, row.name, row.namespace));
      }}
      className="grid cursor-pointer grid-cols-[7px_minmax(0,1fr)_auto_44px] items-center gap-2.5 rounded-[5px] px-1.5 py-[5px] text-xs hover:bg-hover"
    >
      <span
        className={cn("h-[7px] w-[7px] rounded-full", ROLE_DOT[role])}
        aria-hidden="true"
      />
      <span className="flex min-w-0 items-baseline gap-2">
        <ResourceRef
          kind={row.kind}
          name={row.name}
          namespace={row.namespace}
          showKind={false}
        />
        <span className={cn("text-[11px]", WORD[role])}>{row.status}</span>
      </span>
      <span className="text-right text-[11px] text-fg-mut">{row.detail}</span>
      <span
        className="text-right text-[11px] text-fg-fnt"
        title={formatDate(row.timestamp ?? null) ?? undefined}
      >
        {row.timestamp ? age : "—"}
      </span>
    </div>
  );
}

/**
 * The revisions a Deployment has, newest first.
 *
 * A Deployment keeps its old ReplicaSets around scaled to zero, so most of
 * this list is history rather than trouble: the state word is which revision
 * is live, and the count beside it is how many pods each is actually running.
 */
export function RevisionRows({
  revisions,
  emptyMessage,
}: {
  revisions: ReplicaSetInfo[];
  emptyMessage?: string;
}) {
  const t = useT();
  return (
    <ChildRows
      emptyMessage={emptyMessage ?? t("empty", "deploymentHasNoReplicaSets")}
      rows={revisions.map((rs) => {
        const { desired, ready } = rs.replicas;
        const live = rs.revision !== null && rs.revision === rs.currentRevision;
        return {
          kind: ResourceType.ReplicaSet,
          name: rs.name,
          namespace: rs.namespace,
          status: live ? "Current" : "Superseded",
          detail: (
            <>
              {rs.revision !== null && (
                <span className="text-fg-fnt">revision {rs.revision} · </span>
              )}
              {desired === 0 ? (
                <span className="text-fg-fnt">scaled to zero</span>
              ) : (
                <>
                  {ready}
                  <span className="text-fg-fnt">/{desired}</span>
                  <span className="text-fg-fnt"> ready</span>
                </>
              )}
            </>
          ),
          timestamp: rs.createdAt,
        };
      })}
    />
  );
}

/** The Jobs a CronJob has spawned. */
export function JobRows({
  jobs,
  emptyMessage,
}: {
  jobs: JobInfo[];
  emptyMessage?: string;
}) {
  const t = useT();
  return (
    <ChildRows
      emptyMessage={emptyMessage ?? t("empty", "cronJobNotRunYet")}
      rows={jobs.map((job) => ({
        kind: ResourceType.Job,
        name: job.name,
        namespace: job.namespace,
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
