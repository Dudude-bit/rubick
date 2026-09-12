import { beforeEach, describe, expect, it } from "vitest";

import {
  MAX_WATCHES_PER_CLUSTER,
  WATCH_TTL_MS,
  type Watch,
} from "@/lib/tell-me-when";
import { useTellMeWhenStore } from "./tellMeWhenStore";

const state = () => useTellMeWhenStore.getState();

function watch(name: string, context = "prod"): Watch {
  return {
    id: `id-${context}-${name}`,
    context,
    kind: "Pod",
    namespace: "shop",
    name,
    ask: "podReady",
    startedAt: 1_000,
    status: { state: "watching" },
    baseline: { armed: true, restarts: 2 },
  };
}

beforeEach(() => {
  localStorage.clear();
  useTellMeWhenStore.setState({ watches: [] });
});

describe("how many one cluster gets", () => {
  /** Dropping the oldest silently would answer a question nobody asked with silence. */
  it("refuses the thirteenth rather than dropping one", () => {
    for (let i = 0; i < MAX_WATCHES_PER_CLUSTER; i += 1) {
      expect(state().add(watch(`pod-${i}`))).toBe("added");
    }
    expect(state().add(watch("pod-13"))).toBe("full");
    expect(state().watches).toHaveLength(MAX_WATCHES_PER_CLUSTER);
    expect(state().add(watch("pod-0", "staging"))).toBe("added");
  });

  it("makes room only for the one the person named", () => {
    for (let i = 0; i < MAX_WATCHES_PER_CLUSTER; i += 1) {
      state().add(watch(`pod-${i}`));
    }
    state().replace("id-prod-pod-3", watch("pod-13"));
    const names = state()
      .watches.map((w) => w.name)
      .sort();
    expect(names).not.toContain("pod-3");
    expect(names).toContain("pod-13");
  });

  it("does not ask the same question twice", () => {
    state().add(watch("pod-1"));
    expect(state().add(watch("pod-1"))).toBe("already");
  });

  /** An answered watch is not being waited on, so it must not hold a slot. */
  it("counts only the open ones", () => {
    for (let i = 0; i < MAX_WATCHES_PER_CLUSTER; i += 1) {
      state().add(watch(`pod-${i}`));
    }
    state().setStatus("id-prod-pod-0", {
      state: "done",
      verdict: { says: "ready", detail: null },
      at: 2_000,
    });
    expect(state().add(watch("pod-13"))).toBe("added");
  });
});

describe("how long a question lasts", () => {
  it("expires an open watch after a day and leaves an answered one alone", () => {
    state().add(watch("open"));
    state().add(watch("answered"));
    state().setStatus("id-prod-answered", {
      state: "done",
      verdict: { says: "ready", detail: null },
      at: 2_000,
    });
    expect(state().expire(1_000 + WATCH_TTL_MS - 1)).toBe(0);
    expect(state().expire(1_000 + WATCH_TTL_MS)).toBe(1);
    expect(state().watches.find((w) => w.name === "open")?.status.state).toBe(
      "expired"
    );
    expect(
      state().watches.find((w) => w.name === "answered")?.status.state
    ).toBe("done");
  });
});

describe("what is read back off this machine", () => {
  const migrate = (persisted: unknown) =>
    (
      useTellMeWhenStore.persist.getOptions().migrate as (
        p: unknown,
        v: number
      ) => { watches: Watch[] }
    )(persisted, 0).watches;

  /** A baseline from a stream that no longer exists would make the first look after a restart an answer. */
  it("forgets what an open watch had established, and keeps an answer", () => {
    const open = watch("open");
    const done: Watch = {
      ...watch("done"),
      status: {
        state: "done",
        verdict: { says: "ready", detail: null },
        at: 2_000,
      },
    };
    const back = migrate({ watches: [open, done, { junk: true }] });
    expect(back).toHaveLength(2);
    expect(back[0].baseline).toBeNull();
    expect(back[1].baseline).toEqual({ armed: true, restarts: 2 });
  });
});

describe("a deadline", () => {
  /** A silence past the deadline is an answer of its own, with what was last seen. */
  it("closes a watch past its deadline as timed out, carrying the last look", () => {
    useTellMeWhenStore.setState({ watches: [] });
    const store = useTellMeWhenStore.getState();
    store.add({
      id: "d1",
      context: "prod",
      kind: "Deployment",
      namespace: "shop",
      name: "payments",
      ask: "rollout",
      startedAt: 0,
      status: { state: "watching" },
      baseline: { armed: true, seen: "2 of 3 ready" },
      after: { action: "restart", replicas: null, generationBefore: 4 },
      deadline: 120_000,
    });
    expect(store.timeOut(100_000)).toEqual([]);
    const due = useTellMeWhenStore.getState().timeOut(120_000);
    expect(due.map((w) => w.id)).toEqual(["d1"]);
    const closed = useTellMeWhenStore
      .getState()
      .watches.find((w) => w.id === "d1")!;
    expect(closed.status).toEqual({
      state: "done",
      verdict: { says: "timedOut", detail: "2 of 3 ready" },
      at: 120_000,
    });
    expect(useTellMeWhenStore.getState().timeOut(130_000)).toEqual([]);
  });
});
