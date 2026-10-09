import { useEffect, useRef, useState } from "react";
import { listenEvent, listenResourceEvents } from "@/lib/events";

import { commands } from "@/lib/commands";
import { isRefusal } from "@/lib/error-utils";
import {
  currentConnection,
  noteRefusal,
  readOf,
  refusalOf,
} from "@/lib/refusals";
import {
  alreadySeen,
  diffSnapshots,
  snapshotOf,
  type JournalEntry,
  type Snapshot,
} from "@/lib/changes";
import {
  HEARTBEAT_MS,
  useChangeJournalStore,
} from "@/stores/changeJournalStore";
import { useClusterStore } from "@/stores/clusterStore";

interface Row {
  name: string;
  namespace: string;
}

const KINDS: Array<{
  kind: string;
  subscribe: (scope: string[] | null) => Promise<string>;
}> = [
  { kind: "Deployment", subscribe: commands.subscribeDeploymentWatch },
  { kind: "StatefulSet", subscribe: commands.subscribeStatefulsetWatch },
  { kind: "DaemonSet", subscribe: commands.subscribeDaemonsetWatch },
];

let counter = 0;

type Change = Pick<JournalEntry, "field" | "key" | "from" | "to">;
const CREATED: Change = { field: "created", key: null, from: null, to: null };
const DELETED: Change = { field: "deleted", key: null, from: null, to: null };

interface Seen {
  rows: Map<string, Snapshot>;
  /** The creation time of what was deleted under each key. */
  gone: Map<string, string | null>;
  /** When each key was last written, on {@link counter}'s clock. */
  wrote: Map<string, number>;
}

/**
 * Keeps a journal of what the cluster's workloads changed while this app
 * was connected: generation, images, replicas, config checksums. Three
 * cluster-wide watches, one baseline each, entries only for what moved
 * after the baseline. The span it was watching is recorded alongside, so a
 * page can draw the hours it was not.
 */
export function useChangeJournal() {
  const context = useClusterStore((s) => s.currentContext);
  const connected = useClusterStore((s) => s.isConnected);
  // A reader with rights in two namespaces cannot open a cluster-wide watch;
  // the whole feature was dead for them. Asked per namespace instead, the way
  // every multi-namespace list in this app already asks.
  const namespaces = useClusterStore((s) => s.namespaceScope);
  // Kept across a re-subscribe so a relist after a break still knows what the
  // cluster looked like before it, and reports the changes made in the gap.
  // One per object, whichever watch saw it last: a scope switch runs two
  // watches over one namespace, and each change is still one entry.
  const baselines = useRef(new Map<string, Seen>());
  const established = useRef(new Set<string>());
  const [restarts, setRestarts] = useState(0);
  const record = useChangeJournalStore((s) => s.record);
  const seenCluster = useChangeJournalStore((s) => s.seenCluster);
  const beginSpan = useChangeJournalStore((s) => s.beginSpan);
  const heartbeat = useChangeJournalStore((s) => s.heartbeat);
  const endSpan = useChangeJournalStore((s) => s.endSpan);
  // The watches of the scope being left, still watching until the next
  // scope's have synced: a scope switch is not a stretch nobody watched.
  const leaving = useRef<{ cluster: string; retire: (at: number) => void }>(
    null
  );

  useEffect(() => {
    const previous = leaving.current;
    leaving.current = null;
    if (!connected || !context) {
      previous?.retire(Date.now());
      return;
    }
    const cluster = context;
    let predecessor = previous?.cluster === cluster ? previous : null;
    if (previous && !predecessor) previous.retire(Date.now());
    const retirePredecessor = (at: number) => {
      predecessor?.retire(at);
      predecessor = null;
    };
    const scopes: Array<string | null> =
      namespaces.length === 0 ? [null] : namespaces;
    const watches = KINDS.flatMap(({ kind, subscribe }) =>
      scopes.map((namespace) => ({ kind, namespace, subscribe }))
    );
    let active = true;
    const connection = currentConnection();
    // Which cluster this context name turned out to be. A reader who cannot
    // read `kube-system` gets `null`, and nothing is dropped on that.
    void commands
      .getNamespace("kube-system")
      .then((ns) => {
        if (active) seenCluster(cluster, ns.uid || null);
      })
      .catch(() => {
        if (active) seenCluster(cluster, null);
      });
    const streams: Array<{ id: string | null; off: (() => void) | null }> = [];
    // A span opens once every watch has its baseline or was refused; one
    // that never syncs keeps the span shut, and the page draws a gap. A
    // refused kind is named on the span instead of holding the rest shut.
    const synced = new Set<string>();
    const refused = new Set<string>();
    const blind = new Set<() => void>();
    let open = false;
    let ticker: ReturnType<typeof setInterval> | null = null;

    const openSpan = () => {
      if (open) return;
      if (refused.size === watches.length) retirePredecessor(Date.now());
      if (synced.size === 0) return;
      if (synced.size + refused.size < watches.length) return;
      open = true;
      const at = Date.now();
      retirePredecessor(at);
      const unwatched = new Set(
        watches
          .filter((w) => refused.has(`${w.kind}/${w.namespace ?? "*"}`))
          .map((w) => w.kind)
      );
      beginSpan(cluster, at, {
        unwatched: [...unwatched],
        scope: namespaces,
      });
      ticker = setInterval(() => heartbeat(cluster, Date.now()), HEARTBEAT_MS);
    };
    const closeSpan = (at = Date.now()) => {
      if (!open) return;
      open = false;
      if (ticker !== null) clearInterval(ticker);
      ticker = null;
      endSpan(cluster, at);
    };

    for (const { kind, namespace, subscribe } of watches) {
      const stream: (typeof streams)[number] = { id: null, off: null };
      streams.push(stream);
      const watch = `${kind}/${namespace ?? "*"}`;
      const held = `${cluster}|${watch}`;
      const objects = `${cluster}|${kind}`;
      const seen = baselines.current.get(objects) ?? {
        rows: new Map<string, Snapshot>(),
        gone: new Map<string, string | null>(),
        wrote: new Map<string, number>(),
      };
      baselines.current.set(objects, seen);
      const inScope = (key: string) =>
        namespace === null || key.startsWith(`${namespace}/`);
      const comparable = (ns: string) =>
        established.current.has(`${objects}/*`) ||
        established.current.has(`${objects}/${ns}`);
      const apply = (key: string, next: Snapshot): Change[] => {
        const prev = seen.rows.get(key);
        if (prev ? alreadySeen(prev, next) : seen.gone.get(key) === next.born)
          return [];
        seen.rows.set(key, next);
        seen.wrote.set(key, (counter += 1));
        return prev ? diffSnapshots(prev, next) : [CREATED];
      };
      const remove = (key: string, born: string | null): boolean => {
        if (seen.rows.get(key)?.born !== born || !seen.rows.delete(key))
          return false;
        seen.gone.set(key, born);
        seen.wrote.set(key, (counter += 1));
        return true;
      };
      let listFrom = 0;
      let staged: Map<string, Snapshot> | null = null;
      // Anything that blinded this watch — a failure, a lag — makes the next
      // relist a comparison rather than a first sight.
      const goBlind = () => {
        synced.delete(watch);
        staged = null;
        closeSpan();
      };
      blind.add(goBlind);
      const read = readOf("watch", [cluster, watch]);
      const refuse = (error: unknown) => {
        if (read !== null) noteRefusal(read, error, connection);
        if (refused.has(watch)) return;
        goBlind();
        refused.add(watch);
        openSpan();
      };
      const known = read === null ? undefined : refusalOf(read);
      if (known !== undefined) {
        refuse(known);
        continue;
      }

      void (async () => {
        try {
          const id = await subscribe(namespace === null ? null : [namespace]);
          if (!active) {
            await commands.unsubscribeResourceWatch(id).catch(() => {});
            return;
          }
          stream.id = id;
          const off = await listenResourceEvents<Row>((event) => {
            const payload = event.payload;
            if (payload.stream_id !== id) return;
            const now = Date.now();
            const entries: JournalEntry[] = [];
            const relisted = (written: JournalEntry): JournalEntry => ({
              ...written,
              atRelist: true,
            });
            const entry = (row: Row, change: Change): JournalEntry => ({
              id: `${now}-${(counter += 1)}`,
              context: cluster,
              kind,
              namespace: row.namespace,
              name: row.name,
              at: now,
              ...change,
            });
            for (const change of payload.changes) {
              if (change.op === "failed") {
                if (isRefusal(payload.error)) refuse(payload.error);
                else {
                  goBlind();
                  retirePredecessor(Date.now());
                }
                continue;
              }
              if (change.op === "restarted") {
                // The relist is a stretch nothing is being watched, however
                // it ends: the span closes here and reopens on `synced`. A
                // watch that never synced was not in the span, and a refused
                // one announces every retry this way.
                staged = new Map();
                listFrom = counter;
                if (synced.delete(watch)) closeSpan();
                continue;
              }
              if (change.op === "synced") {
                const fresh = staged ?? new Map<string, Snapshot>();
                staged = null;
                // A relist after a break: what differs from before the break
                // is a change this app did not see happen, dated now and
                // said to have happened in the gap before it.
                for (const [key, next] of fresh) {
                  const [row, name] = key.split("/");
                  const changes = apply(key, next);
                  if (!comparable(row)) continue;
                  for (const change of changes)
                    entries.push(
                      relisted(entry({ namespace: row, name }, change))
                    );
                }
                // Absent from a list taken before another watch saw it born.
                for (const [key, prev] of [...seen.rows]) {
                  if (!inScope(key) || fresh.has(key)) continue;
                  if ((seen.wrote.get(key) ?? 0) > listFrom) continue;
                  remove(key, prev.born);
                  const [row, name] = key.split("/");
                  entries.push(
                    relisted(entry({ namespace: row, name }, DELETED))
                  );
                }
                established.current.add(held);
                if (refused.delete(watch)) closeSpan();
                synced.add(watch);
                openSpan();
                continue;
              }
              const row = change.resource;
              if (!row) continue;
              const key = `${row.namespace}/${row.name}`;
              if (staged) {
                if (change.op === "applied")
                  staged.set(key, snapshotOf(kind, row as never));
                continue;
              }
              if (!synced.has(watch)) continue;
              const next = snapshotOf(kind, row as never);
              if (change.op === "deleted") {
                if (remove(key, next.born)) entries.push(entry(row, DELETED));
                continue;
              }
              for (const each of apply(key, next))
                entries.push(entry(row, each));
            }
            if (entries.length > 0) record(entries);
          });
          if (!active) {
            off();
            return;
          }
          stream.off = off;
          await commands.resourceWatchSubscribed(id);
        } catch (error) {
          if (!active) return;
          if (isRefusal(error)) refuse(error);
          else retirePredecessor(Date.now());
        }
      })();
    }

    // The bridge dropping events blinds every watch at once: what it dropped
    // is unknown, so the stretch is a gap, and every watch is re-subscribed
    // rather than left waiting for a relist that may never come.
    const lagged = listenEvent("event-bridge-lagged", () => {
      for (const go of blind) go();
      retirePredecessor(Date.now());
      if (active) setRestarts((n) => n + 1);
    });

    const retire = (at: number) => {
      active = false;
      void lagged.then((off) => off());
      closeSpan(at);
      for (const stream of streams) {
        stream.off?.();
        if (stream.id) {
          void commands.unsubscribeResourceWatch(stream.id).catch(() => {});
        }
      }
    };

    return () => {
      if (open) {
        leaving.current = { cluster, retire };
        return;
      }
      retire(Date.now());
      leaving.current = predecessor;
    };
  }, [
    context,
    connected,
    namespaces,
    restarts,
    record,
    seenCluster,
    beginSpan,
    heartbeat,
    endSpan,
  ]);

  // After the effect above, so its cleanup has handed over before this ends it.
  useEffect(
    () => () => {
      leaving.current?.retire(Date.now());
      leaving.current = null;
    },
    []
  );
}
