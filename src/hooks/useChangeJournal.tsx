import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { commands } from "@/lib/commands";
import {
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

type Op = "applied" | "deleted" | "restarted" | "synced" | "failed";

interface Row {
  name: string;
  namespace: string;
}

interface Payload {
  stream_id: string;
  changes: Array<{ op: Op; resource: Row | null }>;
  error: string | null;
}

/** Matches `EVENT_BRIDGE_LAGGED` in `src-tauri/src/main.rs`. */
const EVENT_BRIDGE_LAGGED = "event-bridge-lagged";

const KINDS: Array<{
  kind: string;
  subscribe: (namespace: string | null) => Promise<string>;
}> = [
  { kind: "Deployment", subscribe: commands.subscribeDeploymentWatch },
  { kind: "StatefulSet", subscribe: commands.subscribeStatefulsetWatch },
  { kind: "DaemonSet", subscribe: commands.subscribeDaemonsetWatch },
];

let counter = 0;

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
  const baselines = useRef(new Map<string, Map<string, Snapshot>>());
  const established = useRef(new Set<string>());
  const [restarts, setRestarts] = useState(0);
  const record = useChangeJournalStore((s) => s.record);
  const seenCluster = useChangeJournalStore((s) => s.seenCluster);
  const beginSpan = useChangeJournalStore((s) => s.beginSpan);
  const heartbeat = useChangeJournalStore((s) => s.heartbeat);
  const endSpan = useChangeJournalStore((s) => s.endSpan);

  useEffect(() => {
    if (!connected || !context) return;
    const cluster = context;
    const scopes: Array<string | null> =
      namespaces.length === 0 ? [null] : namespaces;
    const watches = KINDS.flatMap(({ kind, subscribe }) =>
      scopes.map((namespace) => ({ kind, namespace, subscribe }))
    );
    let active = true;
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
    // A span opens once every watch has its baseline; one that never syncs
    // keeps the span shut, and the page says so by drawing a gap.
    const synced = new Set<string>();
    const blind = new Set<() => void>();
    let open = false;
    let ticker: ReturnType<typeof setInterval> | null = null;

    const openSpan = () => {
      if (open || synced.size < watches.length) return;
      open = true;
      beginSpan(cluster, Date.now());
      ticker = setInterval(() => heartbeat(cluster, Date.now()), HEARTBEAT_MS);
    };
    const closeSpan = () => {
      if (!open) return;
      open = false;
      if (ticker !== null) clearInterval(ticker);
      ticker = null;
      endSpan(cluster, Date.now());
    };

    for (const { kind, namespace, subscribe } of watches) {
      const stream: (typeof streams)[number] = { id: null, off: null };
      streams.push(stream);
      const watch = `${kind}/${namespace ?? "*"}`;
      const held = `${cluster}|${watch}`;
      const rows = baselines.current.get(held) ?? new Map<string, Snapshot>();
      baselines.current.set(held, rows);
      let staged: Map<string, Snapshot> | null = null;
      // Anything that blinded this watch — a failure, a lag — makes the next
      // relist a comparison rather than a first sight.
      const goBlind = () => {
        synced.delete(watch);
        staged = null;
        closeSpan();
      };
      blind.add(goBlind);

      void (async () => {
        try {
          const id = await subscribe(namespace);
          if (!active) {
            await commands.unsubscribeResourceWatch(id).catch(() => {});
            return;
          }
          stream.id = id;
          const off = await listen<Payload>("resource-event", (event) => {
            const payload = event.payload;
            if (payload.stream_id !== id) return;
            const now = Date.now();
            const entries: JournalEntry[] = [];
            const relisted = (written: JournalEntry): JournalEntry => ({
              ...written,
              atRelist: true,
            });
            const entry = (
              row: Row,
              change: Pick<JournalEntry, "field" | "key" | "from" | "to">
            ): JournalEntry => ({
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
                goBlind();
                continue;
              }
              if (change.op === "restarted") {
                // The relist is a stretch nothing is being watched, however
                // it ends: the span closes here and reopens on `synced`.
                staged = new Map();
                synced.delete(watch);
                closeSpan();
                continue;
              }
              if (change.op === "synced") {
                const fresh = staged ?? new Map<string, Snapshot>();
                staged = null;
                // A relist after a break: what differs from before the break
                // is a change this app did not see happen, dated now and
                // said to have happened in the gap before it.
                if (established.current.has(held)) {
                  for (const [key, next] of fresh) {
                    const prev = rows.get(key);
                    const [row, name] = key.split("/");
                    if (!prev) {
                      entries.push(
                        relisted(
                          entry(
                            { namespace: row, name },
                            {
                              field: "created",
                              key: null,
                              from: null,
                              to: null,
                            }
                          )
                        )
                      );
                      continue;
                    }
                    for (const diff of diffSnapshots(prev, next))
                      entries.push(
                        relisted(entry({ namespace: row, name }, diff))
                      );
                  }
                  for (const key of rows.keys()) {
                    if (fresh.has(key)) continue;
                    const [row, name] = key.split("/");
                    entries.push(
                      relisted(
                        entry(
                          { namespace: row, name },
                          { field: "deleted", key: null, from: null, to: null }
                        )
                      )
                    );
                  }
                }
                rows.clear();
                for (const [key, value] of fresh) rows.set(key, value);
                established.current.add(held);
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
              if (change.op === "deleted") {
                if (rows.delete(key))
                  entries.push(
                    entry(row, {
                      field: "deleted",
                      key: null,
                      from: null,
                      to: null,
                    })
                  );
                continue;
              }
              const next = snapshotOf(kind, row as never);
              const prev = rows.get(key);
              rows.set(key, next);
              if (!prev) {
                entries.push(
                  entry(row, {
                    field: "created",
                    key: null,
                    from: null,
                    to: null,
                  })
                );
                continue;
              }
              for (const diff of diffSnapshots(prev, next))
                entries.push(entry(row, diff));
            }
            if (entries.length > 0) record(entries);
          });
          if (!active) {
            off();
            return;
          }
          stream.off = off;
          await commands.resourceWatchSubscribed(id);
        } catch {
          // A kind this cluster refuses to watch keeps the span shut; the
          // page draws the gap rather than a journal that quietly misses it.
        }
      })();
    }

    // The bridge dropping events blinds every watch at once: what it dropped
    // is unknown, so the stretch is a gap, and every watch is re-subscribed
    // rather than left waiting for a relist that may never come.
    const lagged = listen<number>(EVENT_BRIDGE_LAGGED, () => {
      for (const go of blind) go();
      if (active) setRestarts((n) => n + 1);
    });

    return () => {
      active = false;
      void lagged.then((off) => off());
      closeSpan();
      for (const stream of streams) {
        stream.off?.();
        if (stream.id) {
          void commands.unsubscribeResourceWatch(stream.id).catch(() => {});
        }
      }
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
}
