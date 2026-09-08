import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

import { commands } from "@/lib/commands";
import {
  diffSnapshots,
  snapshotOf,
  type JournalEntry,
  type Snapshot,
} from "@/lib/changes";
import { useChangeJournalStore } from "@/stores/changeJournalStore";
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

/** How often an open span is stamped alive; a crash costs at most this much of a gap's honesty. */
export const HEARTBEAT_MS = 30_000;

const KINDS: Array<{ kind: string; subscribe: () => Promise<string> }> = [
  {
    kind: "Deployment",
    subscribe: () => commands.subscribeDeploymentWatch(null),
  },
  {
    kind: "StatefulSet",
    subscribe: () => commands.subscribeStatefulsetWatch(null),
  },
  {
    kind: "DaemonSet",
    subscribe: () => commands.subscribeDaemonsetWatch(null),
  },
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
  const record = useChangeJournalStore((s) => s.record);
  const beginSpan = useChangeJournalStore((s) => s.beginSpan);
  const heartbeat = useChangeJournalStore((s) => s.heartbeat);
  const endSpan = useChangeJournalStore((s) => s.endSpan);

  useEffect(() => {
    if (!connected || !context) return;
    const cluster = context;
    let active = true;
    const streams: Array<{ id: string | null; off: (() => void) | null }> = [];
    // A span opens once every kind has its baseline; a kind that never
    // syncs keeps the span shut, and the page says so by drawing a gap.
    const synced = new Set<string>();
    let open = false;
    let ticker: ReturnType<typeof setInterval> | null = null;

    const openSpan = () => {
      if (open || synced.size < KINDS.length) return;
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

    for (const { kind, subscribe } of KINDS) {
      const stream: (typeof streams)[number] = { id: null, off: null };
      streams.push(stream);
      const rows = new Map<string, Snapshot>();
      let staged: Map<string, Snapshot> | null = null;

      void (async () => {
        try {
          const id = await subscribe();
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
                synced.delete(kind);
                closeSpan();
                continue;
              }
              if (change.op === "restarted") {
                staged = new Map();
                continue;
              }
              if (change.op === "synced") {
                const fresh = staged ?? new Map<string, Snapshot>();
                staged = null;
                // A relist after a break: what differs from before the break
                // is a change this app did not see happen, dated now and
                // marked by the gap the page draws before it.
                if (synced.has(kind)) {
                  for (const [key, next] of fresh) {
                    const prev = rows.get(key);
                    const [namespace, name] = key.split("/");
                    if (!prev) {
                      entries.push(
                        entry(
                          { namespace, name },
                          { field: "created", key: null, from: null, to: null }
                        )
                      );
                      continue;
                    }
                    for (const diff of diffSnapshots(prev, next))
                      entries.push(entry({ namespace, name }, diff));
                  }
                  for (const key of rows.keys()) {
                    if (fresh.has(key)) continue;
                    const [namespace, name] = key.split("/");
                    entries.push(
                      entry(
                        { namespace, name },
                        { field: "deleted", key: null, from: null, to: null }
                      )
                    );
                  }
                }
                rows.clear();
                for (const [key, value] of fresh) rows.set(key, value);
                synced.add(kind);
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
              if (!synced.has(kind)) continue;
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

    return () => {
      active = false;
      closeSpan();
      for (const stream of streams) {
        stream.off?.();
        if (stream.id) {
          void commands.unsubscribeResourceWatch(stream.id).catch(() => {});
        }
      }
    };
  }, [context, connected, record, beginSpan, heartbeat, endSpan]);
}
