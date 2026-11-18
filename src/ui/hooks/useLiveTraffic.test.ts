import { describe, expect, it } from "vite-plus/test";

import type { FlowEnd, LivePair } from "@/generated/types";
import { LiveStore } from "./useLiveTraffic";

const end = (name: string): FlowEnd => ({
  is: "workload",
  key: { namespace: "shop", group: "apps", kind: "Deployment", name },
});

const pair = (from: string, to: string, forwarded: number): LivePair => ({
  from: end(from),
  to: end(to),
  forwarded,
  dropped: 0,
  drops: [],
  requests: null,
  errors: null,
  p50: null,
  p95: null,
  p99: null,
  protocols: [],
});

describe("what a live stream holds", () => {
  /**
   * A batch replaces only the pairs it names and removes the ones it says
   * went; every other pair is the object it was, so its row is kept.
   */
  it("replaces only the pairs a batch names and drops the ones it says went", () => {
    const store = new LiveStore();
    const kept = pair("web", "db", 1);
    store.apply({
      pairs: [kept, pair("web", "api", 1)],
      gone: [],
      relay: {
        namespace: "kube-system",
        service: "hubble-relay",
        pod: "r-1",
        tls: false,
      },
      lost: 0,
      untracked: 0,
      waiting: 0,
      unreached: [],
    });
    store.apply({
      pairs: [pair("web", "api", 2)],
      gone: [{ from: end("web"), to: end("cache") }],
      relay: null,
      lost: 5,
      untracked: 0,
      waiting: 4,
      unreached: [
        { name: "kind/worker", state: "NODE_UNAVAILABLE", message: "" },
      ],
    });
    const now = store.snapshot();
    expect(now.unreached.map((node) => node.name)).toEqual(["kind/worker"]);
    expect(now.phase).toBe("live");
    expect(now.relay?.pod).toBe("r-1");
    expect(now.lost).toBe(5);
    expect(now.waiting).toBe(4);
    expect([...now.pairs.values()]).toContain(kept);
    expect([...now.pairs.values()].map((p) => p.forwarded).sort()).toEqual([
      1, 2,
    ]);
    store.apply({
      pairs: [],
      gone: [{ from: end("web"), to: end("db") }],
      relay: null,
      lost: 5,
      untracked: 0,
      waiting: 0,
      unreached: [],
    });
    expect(store.snapshot().pairs.size).toBe(1);
  });

  /** An end is held as said, and a batch after it does not reopen the stream. */
  it("stays ended once the stream said how it ended", () => {
    const store = new LiveStore();
    store.ended({ says: "mutualTls", namespace: "kube-system" });
    store.apply({
      pairs: [],
      gone: [],
      relay: null,
      lost: 0,
      untracked: 0,
      waiting: 0,
      unreached: [],
    });
    expect(store.snapshot().phase).toBe("ended");
    expect(store.snapshot().end).toEqual({
      says: "mutualTls",
      namespace: "kube-system",
    });
  });
});
