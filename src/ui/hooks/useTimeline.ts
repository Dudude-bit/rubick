import { useCallback, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  Keeping,
  LetGoes,
  Show,
  SpanSets,
  Subject,
  TimelinePage,
  TimelineRow,
} from "@/generated/types";
import { commands } from "@/lib/commands";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { listenEvent } from "@/lib/events";
import { queryKeys } from "@/lib/query-keys";
import { useClusterStore } from "@/stores/clusterStore";

/** The key the 5.0 journal kept itself under in the window's own storage. */
const OLD_JOURNAL = "change-journal";

/** The 5.0 journal is not read any more: its rows go, once, on start. */
export function forgetOldJournal(): void {
  try {
    globalThis.localStorage?.removeItem(OLD_JOURNAL);
  } catch {
    // A refused store holds nothing to forget.
  }
}

export interface TimelineAsk {
  /** One object's timeline, or the cluster's where absent. */
  subject?: Subject | null;
  /** The namespaces on screen, `[]` for all. */
  scope?: readonly string[];
  windowMs: number;
  show: Show;
  enabled?: boolean;
}

/** What a surface draws from: the rows read so far, newest first, and what is not known about the rest. */
export interface TimelineRead {
  /** Whether anything was read at all: no rows before it is not "none". */
  read: boolean;
  rows: readonly TimelineRow[];
  spans: SpanSets | undefined;
  letGo: LetGoes | undefined;
  keeping: Keeping | undefined;
  unreadable: number;
  /** Where the rows read end while older ones remain unread; `null` when all are read. */
  readFrom: number | null;
  loadOlder: () => void;
  isPending: boolean;
  error: Error | null;
}

const NO_ROWS: readonly TimelineRow[] = [];

const newer = (a: TimelineRow, b: TimelineRow) => b.at - a.at || b.seq - a.seq;

/**
 * Rows recorded since the last read, laid into the ones held: a repeat of a
 * series leaves its old place. Both lists are newest first, so this costs the
 * held list once and sorts only what arrived; untouched rows keep their identity.
 */
export function withNewer(
  held: readonly TimelineRow[],
  arrived: readonly TimelineRow[]
): TimelineRow[] {
  if (arrived.length === 0) return [...held];
  const fresh = [...arrived].sort(newer);
  const ids = new Set(fresh.map((row) => row.id));
  const out: TimelineRow[] = [];
  let i = 0;
  let j = 0;
  while (i < held.length || j < fresh.length) {
    if (i < held.length && ids.has(held[i].id)) {
      i += 1;
      continue;
    }
    if (
      j === fresh.length ||
      (i < held.length && newer(held[i], fresh[j]) <= 0)
    )
      out.push(held[i++]);
    else out.push(fresh[j++]);
  }
  return out;
}

/**
 * The one way a surface reads the timeline: the Changes page, an object's
 * Changes tab, a pinned service's card and Share all ask here. The first
 * page is read once; after it only what was recorded since, when the
 * backend says something was, and older pages when the reader scrolls to them.
 */
export function useTimeline(ask: TimelineAsk): TimelineRead {
  const context = useClusterStore((s) => s.currentContext);
  const client = useQueryClient();
  const scope = ask.scope ?? NO_SCOPE;
  // By its fields: a page that builds the subject inline asks the same question.
  const kind = ask.subject?.kind;
  const group = ask.subject?.group ?? null;
  const namespace = ask.subject?.namespace ?? null;
  const name = ask.subject?.name ?? "";
  const subject = useMemo<Subject | null>(
    () => (kind === undefined ? null : { kind, group, namespace, name }),
    [kind, group, namespace, name]
  );
  const key = useMemo(
    () => queryKeys.timeline(context, subject, scope, ask.windowMs, ask.show),
    [context, subject, scope, ask.windowMs, ask.show]
  );
  const question = useCallback(
    (over: Partial<Parameters<typeof commands.timelineRead>[0]>) => ({
      context: context ?? "",
      subject,
      scope: scope.length > 0 ? [...scope] : null,
      from: Date.now() - ask.windowMs,
      show: ask.show,
      after: null,
      before: null,
      ...over,
    }),
    [context, subject, scope, ask.windowMs, ask.show]
  );
  const enabled = (ask.enabled ?? true) && context !== null;
  const query = useQuery({
    queryKey: key,
    queryFn: () => commands.timelineRead(question({})),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    if (!enabled) return;
    let reading = false;
    let again = false;
    const catchUp = async () => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      try {
        const held = client.getQueryData<TimelinePage>(key);
        if (!held) return;
        const page = await commands.timelineRead(
          question({ after: held.newest })
        );
        if (page.more) {
          await client.invalidateQueries({ queryKey: key, exact: true });
          return;
        }
        client.setQueryData<TimelinePage>(key, (now) =>
          now
            ? {
                ...page,
                rows: withNewer(now.rows, page.rows),
                more: now.more,
              }
            : now
        );
      } catch {
        // The next change asks again; a failed catch-up leaves what was read.
      } finally {
        reading = false;
        if (again) {
          again = false;
          void catchUp();
        }
      }
    };
    const off = listenEvent("timeline-changed", ({ payload }) => {
      if (payload.context === context) void catchUp();
    });
    return () => void off.then((unlisten) => unlisten());
  }, [enabled, client, key, question, context]);

  const data = query.data;
  const loadOlder = useCallback(() => {
    const held = client.getQueryData<TimelinePage>(key);
    const last = held?.rows.at(-1);
    if (!held?.more || !last) return;
    void commands
      .timelineRead(question({ before: { at: last.at, seq: last.seq } }))
      .then((page) =>
        client.setQueryData<TimelinePage>(key, (now) =>
          now && now.rows.at(-1)?.seq === last.seq
            ? { ...now, rows: [...now.rows, ...page.rows], more: page.more }
            : now
        )
      )
      .catch(() => {});
  }, [client, key, question]);

  return {
    read: data !== undefined,
    rows: data?.rows ?? NO_ROWS,
    spans: data?.spans,
    letGo: data?.letGo,
    keeping: data?.keeping,
    unreadable: data?.unreadable ?? 0,
    readFrom: data?.more ? (data.rows.at(-1)?.at ?? null) : null,
    loadOlder,
    isPending: enabled && query.isPending,
    error: query.error,
  };
}

const NO_SCOPE: readonly string[] = [];

/**
 * While a timeline is on screen the backend holds open what it reads by name
 * only, and lets it go once no screen says so: said again at the steady rate,
 * which stops when the surface is out of sight.
 */
export function useTimelineHold(enabled = true): void {
  const context = useClusterStore((s) => s.currentContext);
  useLiveQuery({
    refresh: "steady",
    queryKey: queryKeys.timelineHold(context),
    queryFn: () => commands.timelineHold(context ?? ""),
    enabled: enabled && context !== null,
  });
}
