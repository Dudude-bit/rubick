import { useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  useIsFetching,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { Info, Lock, TriangleAlert, X } from "lucide-react";

import { ErrorDetails } from "@/components/ui/error-details";
import { ReadAgain } from "@/components/ui/read-again";
import { CopyRule } from "@/components/ui/unknown";
import { parseRefusal } from "@/lib/refusal";
import { formatWhen } from "@/lib/utils";
import { HeldLines } from "../-list/HeldLines";
import { UnreadNamespaces } from "../-list/UnreadNamespaces";
import { ListUnread } from "../-list/list-unread";
import { cn } from "@/lib/utils";
import { commands } from "@/lib/commands";
import { ERROR_CODES } from "@/lib/error-utils";
import { useT } from "@/i18n/useT";
import { absenceOf, type MetricsAbsence } from "@/lib/metrics-absence";
import { queryKeys } from "@/lib/query-keys";
import { REFUSAL_RECHECK_MS } from "../-list/useRecheckRefusal";
import { useClusterStore } from "@/stores/clusterStore";
import { useMetricsNoticeStore } from "@/stores/metricsNoticeStore";
import type { MetricsStatus, UnreadNamespace } from "@/generated/types";

interface MetricsStatusBannerProps {
  status?: MetricsStatus | null;
  /** Namespaces of a selection whose samples were not read while others were. */
  unread?: readonly UnreadNamespace[];
  onRetry?: () => void;
  className?: string;
}

/**
 * A missing or refused metrics API is a fact about the cluster that only an
 * admin can change, so it is said calmly and never in the red a broken
 * workload wears. A refused or failing read is drawn as every could-not-look
 * is; a missing install is information, and only it may be put away.
 */
const NOTICE: Record<
  MetricsAbsence,
  {
    title:
      | "metricsNotInstalled"
      | "metricsForbidden"
      | "metricsNotAnswering"
      | "metricsError";
    body:
      | "metricsNotInstalledBody"
      | "metricsForbiddenBody"
      | "metricsNotAnsweringBody"
      | "metricsErrorBody";
    since:
      | "metricsRefusedSince"
      | "metricsSilentSince"
      | "metricsFailingSince"
      | null;
    glyph: typeof Lock;
    code: string;
  }
> = {
  notInstalled: {
    title: "metricsNotInstalled",
    body: "metricsNotInstalledBody",
    since: null,
    glyph: Info,
    code: ERROR_CODES.NOT_FOUND,
  },
  forbidden: {
    title: "metricsForbidden",
    body: "metricsForbiddenBody",
    since: "metricsRefusedSince",
    glyph: Lock,
    code: ERROR_CODES.PERMISSION,
  },
  notAnswering: {
    title: "metricsNotAnswering",
    body: "metricsNotAnsweringBody",
    since: "metricsSilentSince",
    glyph: TriangleAlert,
    code: ERROR_CODES.NO_ANSWER,
  },
  error: {
    title: "metricsError",
    body: "metricsErrorBody",
    since: "metricsFailingSince",
    glyph: TriangleAlert,
    code: ERROR_CODES.UNKNOWN,
  },
};

const NONE_HIDDEN: readonly MetricsAbsence[] = [];

const firstSeen = new Map<string, number>();

function firstAnswered(queryClient: QueryClient, absence: MetricsAbsence) {
  const times = queryClient
    .getQueryCache()
    .findAll({ queryKey: queryKeys.metrics.all() })
    .filter(
      (query) =>
        absenceOf(
          (query.state.data as { status?: MetricsStatus } | undefined)?.status
        ) === absence
    )
    .map((query) => query.state.dataUpdatedAt);
  return times.length ? Math.min(...times) : null;
}

/**
 * When the first refused or failed answer arrived, taken from the query that
 * got it rather than from this banner's mount; kept across visits and not
 * moved by a cached answer repeating it; let go once metrics answer.
 */
function useFirstSeen(
  context: string | null,
  absence: MetricsAbsence | null,
  known: boolean
): number | null {
  const queryClient = useQueryClient();
  const key =
    context && absence && NOTICE[absence].since
      ? `${context}:${absence}`
      : null;
  const [now] = useState(Date.now);
  const kept = key
    ? (firstSeen.get(key) ??
      (absence && firstAnswered(queryClient, absence)) ??
      now)
    : null;
  useEffect(() => {
    if (key && kept !== null && !firstSeen.has(key)) firstSeen.set(key, kept);
    if (!key && context && known)
      for (const seen of [...firstSeen.keys()])
        if (seen.startsWith(`${context}:`)) firstSeen.delete(seen);
  }, [key, kept, context, known]);
  return kept;
}

function recheck(queryClient: QueryClient) {
  return commands
    .recheckMetrics()
    .finally(
      () =>
        void queryClient.refetchQueries({ queryKey: queryKeys.metrics.all() })
    );
}

const answeredSomewhere = (queryClient: QueryClient) =>
  queryClient
    .getQueryCache()
    .findAll({ queryKey: queryKeys.metrics.all() })
    .some(
      (query) =>
        (query.state.data as { status?: MetricsStatus } | undefined)?.status
          ?.status === "available"
    );

/**
 * The backend keeps a refusal or a missing install for minutes, and answers
 * every read of it from there, so a list kept its lock while the object page
 * opened from it read live usage. Another reader's answer asks again, at most
 * once a minute: a namespace-only role is refused across the cluster again.
 */
function useYieldToAnswer(unserved: boolean) {
  const queryClient = useQueryClient();
  const asked = useRef(0);
  const [answered, setAnswered] = useState(false);
  useEffect(() => {
    if (!unserved) return;
    const look = () => setAnswered(answeredSomewhere(queryClient));
    look();
    return queryClient.getQueryCache().subscribe(look);
  }, [queryClient, unserved]);
  useEffect(() => {
    if (!unserved || !answered) return;
    if (Date.now() - asked.current < REFUSAL_RECHECK_MS) return;
    asked.current = Date.now();
    void recheck(queryClient);
  }, [queryClient, unserved, answered]);
}

export function MetricsStatusBanner({
  status,
  unread,
  onRetry,
  className,
}: MetricsStatusBannerProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const listUnread = useContext(ListUnread);
  const checking = useIsFetching({ queryKey: queryKeys.metrics.all() }) > 0;
  const context = useClusterStore((s) => s.currentContext);
  const hidden =
    useMetricsNoticeStore((s) => (context ? s.hidden[context] : undefined)) ??
    NONE_HIDDEN;
  const hide = useMetricsNoticeStore((s) => s.hide);
  const absence = absenceOf(status);
  const [settled, setSettled] = useState(false);
  const absent = !!status && absence !== null;
  if (absent && !checking && !settled) setSettled(true);
  if (!absent && settled) setSettled(false);
  useYieldToAnswer(absence === "forbidden" || absence === "notInstalled");
  // A new answer each time a read ends, so the retry is busy until one has.
  const [reads, setReads] = useState({ checking, ended: 0 });
  if (reads.checking !== checking)
    setReads({ checking, ended: reads.ended + (checking ? 0 : 1) });
  const details = status?.message?.trim();
  const since = useFirstSeen(context, absence, !!status);
  const rule = details ? parseRefusal(details) : null;
  const said = useMemo(
    () =>
      absence &&
      Object.assign(new Error(details || t("cluster", NOTICE[absence].body)), {
        code: NOTICE[absence].code,
        ended: reads.ended,
      }),
    [absence, details, t, reads.ended]
  );

  // The list under it was not read: there is no CPU column to explain.
  if (!status || listUnread) return null;
  if (absence === null) {
    return unread?.length ? (
      <UnreadNamespaces
        unread={unread}
        label={t("cluster", "podMetricsLabel")}
        onRetry={onRetry}
      />
    ) : null;
  }
  if (absence === "notInstalled" && hidden.includes(absence)) return null;
  if (!settled) return null;

  const { title, body, since: sinceWords, glyph: Glyph } = NOTICE[absence];
  const information = absence === "notInstalled";

  return (
    <div
      role="status"
      data-read={information ? undefined : absence}
      className={cn(
        "mb-2 flex items-start gap-2 rounded-md border border-hair px-3 py-2 text-xs",
        !information && "border-dashed",
        className
      )}
    >
      <Glyph
        className={cn(
          "mt-0.5 h-3.5 w-3.5 flex-none",
          information ? "text-info" : "text-warn"
        )}
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {/* Above a list, so a peek opening beside it must not wrap them
              onto more lines and move the rows under the pointer. */}
        <div>
          <p className="text-fg">
            <HeldLines>{t("cluster", title)}</HeldLines>
          </p>
          <p className="text-fg-mut">
            <HeldLines>{t("cluster", body)}</HeldLines>
          </p>
          {since !== null && sinceWords && (
            <p className="text-caption text-fg-fnt" data-testid="metrics-since">
              {t("cluster", sinceWords, { time: formatWhen(since, "clock") })}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-start gap-1.5">
          {said && (
            <ReadAgain error={said} onRetry={() => recheck(queryClient)} />
          )}
          {rule && <CopyRule refusal={rule} />}
          {details && <ErrorDetails text={details} />}
        </div>
      </div>
      {context && information && (
        <button
          type="button"
          aria-label={t("cluster", "metricsHideForCluster")}
          title={t("cluster", "metricsHideForCluster")}
          onClick={() => hide(context, absence)}
          className="flex-none rounded p-0.5 text-fg-fnt transition-colors hover:bg-hover hover:text-fg"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
