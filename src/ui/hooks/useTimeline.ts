import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";

import type {
  Identity,
  Keeping,
  LetGoes,
  SeqStretch,
  Show,
  SpanSets,
  TimelineSubject,
  TimelinePage,
  TimelineRow,
} from "@/generated/types";
import { commands } from "@/lib/commands";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { listenEvent } from "@/lib/events";
import { errorToShow } from "@/lib/error-utils";
import { queryKeys } from "@/lib/query-keys";
import { nameIsAnotherCluster } from "@/lib/kept-by-name";
import { builtInGroupOf } from "@/lib/links";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
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
  subject?: TimelineSubject | null;
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
  /** Whether this name was checked through the connection held now. */
  identity: Identity | undefined;
  /** The rows a connection read to be this cluster recorded; see `placedBy`. */
  vouched: readonly SeqStretch[] | undefined;
  unreadable: number;
  /** Where the rows read end while older ones remain unread; `null` when all are read. */
  readFrom: number | null;
  loadOlder: () => void;
  isPending: boolean;
  error: Error | null;
}

const NO_ROWS: readonly TimelineRow[] = [];

type Placed = Pick<TimelineRow, "at" | "seq">;

const newer = (a: Placed, b: Placed) => b.at - a.at || b.seq - a.seq;

/**
 * Rows recorded since the last read, laid into the ones held: a repeat of a
 * series leaves its old place. Both lists are newest first, so this costs the
 * held list once and sorts only what arrived; untouched rows keep their identity.
 * Below `tail`, the last row held while older ones remain unread, a row
 * arrived is left for the page that reads there: laid in, it would become the
 * tail, and the next page would start below rows nobody read.
 */
export function withNewer(
  held: readonly TimelineRow[],
  arrived: readonly TimelineRow[],
  tail: Placed | null = null
): TimelineRow[] {
  if (arrived.length === 0) return [...held];
  // A series held in a later version than one arriving late keeps it: two
  // readers of one key may have their answers laid in out of order.
  const heldSeq = new Map<string, number>();
  const wanted = new Set(arrived.map((row) => row.id));
  for (const row of held) if (wanted.has(row.id)) heldSeq.set(row.id, row.seq);
  const later = arrived.filter((row) => (heldSeq.get(row.id) ?? -1) < row.seq);
  const ids = new Set(later.map((row) => row.id));
  const fresh = later
    .filter((row) => tail === null || newer(row, tail) <= 0)
    .sort(newer);
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
  // A page that names no group is a built-in kind's: a namesake in another
  // group is not this object, and its rows are not its history.
  const group =
    ask.subject?.group ?? (kind === undefined ? null : builtInGroupOf(kind));
  const namespace = ask.subject?.namespace ?? null;
  const name = ask.subject?.name ?? "";
  const subject = useMemo<TimelineSubject | null>(
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

  const hasData = query.data !== undefined;
  // A catch-up that failed leaves the rows held as of the last that did:
  // said, so nothing calls the stretch since quiet.
  const [behind, setBehind] = useState<{
    key: typeof key;
    error: Error;
  } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let reading = false;
    let again = false;
    // An answer to a question this surface no longer asks says nothing of
    // the one it asks now: neither its failure nor its success is written.
    let active = true;
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
        if (active) setBehind(null);
        // The rows started over, for another cluster under the name or a
        // clear: what is held is not this timeline's any more.
        if (page.epoch !== held.epoch) {
          await startOver(client, key, page.epoch);
          return;
        }
        if (page.more) {
          await client.invalidateQueries({ queryKey: key, exact: true });
          return;
        }
        // Rows that left the window go: kept, a page left open for days
        // held every row it was ever told of.
        const from = Date.now() - ask.windowMs;
        // Checked against what is held now, not when it was asked: a reset
        // meanwhile holds another cluster's rows, numbered from the start.
        client.setQueryData<TimelinePage>(key, (now) =>
          now && now.epoch === page.epoch
            ? {
                ...page,
                rows: withNewer(
                  now.rows,
                  page.rows,
                  now.more ? (now.rows.at(-1) ?? null) : null
                ).filter((row) => row.at >= from),
                newest: Math.max(now.newest, page.newest),
                more: now.more,
              }
            : now
        );
      } catch (error) {
        // The next change asks again; until it answers, what is held is old.
        if (active)
          setBehind({
            key,
            error:
              error instanceof Error ? error : new Error(errorToShow(error)),
          });
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
    // Rows held from before this surface listened, kept by the cache while
    // it was closed or read before a news it missed, are caught up once
    // the listener is in place.
    void off.then(() => {
      if (hasData) void catchUp();
    });
    return () => {
      active = false;
      void off.then((unlisten) => unlisten());
    };
  }, [enabled, client, key, question, context, hasData, ask.windowMs]);

  const data = query.data;
  const loadOlder = useCallback(() => {
    const held = client.getQueryData<TimelinePage>(key);
    const last = held?.rows.at(-1);
    if (!held?.more || !last) return;
    void commands
      .timelineRead(question({ before: { at: last.at, seq: last.seq } }))
      .then((page) => {
        if (page.epoch !== held.epoch) {
          void startOver(client, key, page.epoch);
          return;
        }
        client.setQueryData<TimelinePage>(key, (now) => {
          if (
            !now ||
            now.epoch !== page.epoch ||
            now.rows.at(-1)?.seq !== last.seq
          )
            return now;
          // A series a catch-up moved up while this page was read is held
          // already, in its later place.
          const held = new Set(now.rows.map((row) => row.id));
          const older = page.rows.filter((row) => !held.has(row.id));
          return { ...now, rows: [...now.rows, ...older], more: page.more };
        });
      })
      .catch(() => {});
  }, [client, key, question]);

  return {
    read: data !== undefined,
    rows: data?.rows ?? NO_ROWS,
    spans: data?.spans,
    letGo: data?.letGo,
    keeping: data?.keeping,
    identity: data?.identity,
    vouched: data?.vouched,
    unreadable: data?.unreadable ?? 0,
    readFrom: data?.more ? (data.rows.at(-1)?.at ?? null) : null,
    loadOlder,
    isPending: enabled && query.isPending,
    error: query.error ?? (behind?.key === key ? behind.error : null),
  };
}

const NO_SCOPE: readonly string[] = [];

/**
 * Rows held of a numbering older than `epoch`, the one an answer came
 * from, read again from the top. Ones of it or later are left: a reader
 * already read them since this answer was asked, and resetting them again
 * drops what it read. A cluster's numbering only ever moves up.
 */
function startOver(client: QueryClient, key: QueryKey, epoch: number) {
  const held = client.getQueryData<TimelinePage>(key)?.epoch;
  return held !== undefined && held < epoch
    ? client.resetQueries({ queryKey: key, exact: true })
    : Promise.resolve();
}

/**
 * While a timeline is on screen the backend keeps the ownership index
 * reading, and records what it reads by name only; said again at the steady
 * rate, which stops when the surface is out of sight.
 */
export function useTimelineHold(enabled = true): void {
  const context = useClusterStore((s) => s.currentContext);
  const scope = useNamespaceScope();
  useLiveQuery({
    refresh: "steady",
    queryKey: queryKeys.timelineHold(context),
    queryFn: () => commands.timelineHold(scope.wire),
    enabled: enabled && context !== null,
  });
}

/**
 * Records the cluster on screen, for the window's whole life: once per
 * connect and context, and its namespaces again when they change. Another
 * cluster found under the name lets go of what is kept under it everywhere.
 */
export function useTimelineFollow(): void {
  const context = useClusterStore((s) => s.currentContext);
  const connected = useClusterStore((s) => s.isConnected);
  // By its names: the scope's array is a new one on many renders.
  const key = useNamespaceScope().wire?.join(",") ?? null;
  useEffect(() => {
    if (!connected || !context) return;
    let active = true;
    commands
      .timelineFollow(key === null ? null : key.split(","))
      .then((answer) => {
        if (active && answer.anotherCluster) nameIsAnotherCluster(context);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [connected, context, key]);
}
