import { describe, expect, it } from "vitest";

import {
  changesFor,
  entryPointsOf,
  MAX_PINNED_PER_CONTEXT,
  openQuestionsOf,
  pinKey,
  stateOf,
  waitingFor,
} from "./my-services";
import type { ChainPath } from "./connections";
import type { JournalEntry } from "./changes";
import type { Watch } from "./tell-me-when";
import type { ObjectRef, ResourceConnections } from "@/generated/types";

function ref(kind: string, name: string): ObjectRef {
  return { kind, name, namespace: "shop", existence: "present", facts: null };
}

function conns(over: Partial<ResourceConnections> = {}): ResourceConnections {
  return {
    subject: {
      kind: "Deployment",
      name: "payments",
      namespace: "shop",
      existence: "present",
      facts: {
        kind: "workload",
        replicas: 3,
        readyReplicas: 3,
        revision: null,
        current: null,
      },
    },
    edges: [],
    stops: [],
    published: [],
    notLookedAt: [],
    ...over,
  };
}

describe("stateOf", () => {
  it("counts the replicas that are ready against the ones there are", () => {
    expect(stateOf(conns(), null)).toEqual({
      state: "ready",
      ready: 3,
      total: 3,
    });
  });

  it("says a workload is short while some of its replicas are not ready", () => {
    const short = conns({
      subject: {
        ...conns().subject,
        facts: {
          kind: "workload",
          replicas: 3,
          readyReplicas: 1,
          revision: null,
          current: null,
        },
      },
    });
    expect(stateOf(short, null)).toEqual({
      state: "short",
      ready: 1,
      total: 3,
    });
  });

  /**
   * The defect this page would otherwise ship: a service somebody deleted and
   * one this token may not read both arrive as no answer, and drawing either
   * as "0 ready" tells the reader their service is down when it is not there,
   * or that it is down when nobody looked.
   */
  it("tells a service that is gone from one it could not read", () => {
    expect(
      stateOf(undefined, {
        message: "Resource not found: Deployment/payments in namespace shop",
      })
    ).toEqual({
      state: "gone",
    });
    const unread = stateOf(undefined, {
      message: "Permission denied: deployments.apps is forbidden",
    });
    expect(unread.state).toBe("unread");
    expect(unread).toMatchObject({
      why: "Permission denied: deployments.apps is forbidden",
    });
  });

  /**
   * The read is kept across refreshes, so a workload deleted or refused
   * after the first good answer left that answer on screen — green, with
   * the failure sitting beside it unread.
   */
  it("does not keep the last good answer when the next read failed", () => {
    expect(
      stateOf(
        conns(),
        { message: "services is forbidden" },
        {
          kind: "Deployment",
          name: "payments",
        }
      ).state
    ).toBe("unread");
  });

  /**
   * "Client not found" and "Plugin not found" are this app failing, not the
   * cluster answering. Reading them as a deleted workload sends somebody to
   * rebuild something that is still running.
   */
  it("calls a workload gone only when the cluster said so about it", () => {
    const pin = { kind: "Deployment", name: "payments" };
    expect(stateOf(undefined, { message: "Client not found" }, pin).state).toBe(
      "unread"
    );
    expect(
      stateOf(
        undefined,
        {
          message: "Resource not found: Deployment/payments in namespace shop",
        },
        pin
      ).state
    ).toBe("gone");
  });

  /**
   * A CronJob has no replicas to be ready. The backend reports 0 of 0, which
   * read as "all ready" and drew green about a schedule nobody had checked.
   */
  it("does not call a CronJob ready because it has no replicas", () => {
    const cron = conns({
      subject: {
        kind: "CronJob",
        name: "nightly",
        namespace: "shop",
        existence: "present",
        facts: {
          kind: "workload",
          replicas: 0,
          readyReplicas: 0,
          revision: null,
          current: null,
        },
      } as never,
    });
    expect(
      stateOf(cron, null, { kind: "CronJob", name: "nightly" }).state
    ).not.toBe("ready");
  });

  it("carries a subject the read found missing", () => {
    const missing = conns({
      subject: { ...conns().subject, existence: "missing", facts: null },
    });
    expect(stateOf(missing, null)).toEqual({ state: "gone" });
  });
  /**
   * The first second of every visit: nothing has answered yet, and the card
   * said "could not read" about a read that was still running.
   */
  it("tells a read still in flight from one that failed", () => {
    expect(stateOf(undefined, null, undefined, true).state).toBe("reading");
    expect(stateOf(undefined, null, undefined, false).state).toBe("unread");
  });
});

describe("entryPointsOf", () => {
  const chain = (hops: ChainPath["hops"]): ChainPath[] => [
    { key: "c", hops, broken: false },
  ];

  it("offers the address a person can paste, ahead of the service behind it", () => {
    const { entries } = entryPointsOf(
      conns(),
      chain([
        {
          at: "object",
          object: ref("Ingress", "shop"),
          self: false,
          detail: "nginx",
          via: null,
          urls: ["https://shop.example.com"],
          publishedAt: null,
        },
        {
          at: "object",
          object: ref("Service", "payments"),
          self: false,
          detail: "80/TCP",
          via: null,
          urls: [],
          publishedAt: null,
        },
      ])
    );
    expect(entries.map((entry) => entry.label)).toEqual([
      "https://shop.example.com",
      "payments",
    ]);
    expect(entries[0].url).toBe("https://shop.example.com");
  });

  it("says whether anything is behind the service, and whether that was read", () => {
    const { entries } = entryPointsOf(
      conns(),
      chain([
        {
          at: "published",
          published: {
            service: ref("Service", "payments"),
            source: "slices",
            slices: 1,
            ready: 0,
            draining: 0,
            notReady: 2,
            unrouted: 0,
            ports: [{ name: "http", port: 80, protocol: "TCP", exposed: true }],
            endpoints: [],
            whole: true,
            unpublished: [],
          },
          first: null,
          address: null,
          summary: "",
          tone: "warn",
        },
      ])
    );
    expect(entries[0]).toMatchObject({
      label: "payments",
      detail: "http",
      serving: false,
      servingKnown: true,
    });
  });

  /**
   * An unread neighbourhood and a service nothing publishes are both an empty
   * list here; only the flag tells them apart, and the panel needs it to
   * choose between "nothing publishes this" and saying nothing at all.
   */
  it("marks the answer unknown while no neighbourhood has been read", () => {
    expect(entryPointsOf(undefined, [])).toEqual({ entries: [], known: false });
    expect(entryPointsOf(conns(), [])).toEqual({ entries: [], known: true });
  });
  /**
   * The object hop and the published hop are the same Service under the same
   * key, and only the published one knows whether anything is behind it.
   * First-one-wins dropped that answer every time, so "nothing behind it"
   * could never be drawn.
   */
  it("keeps the hop that knows whether anything is behind the service", () => {
    const { entries } = entryPointsOf(
      conns(),
      chain([
        {
          at: "object",
          object: ref("Service", "payments"),
          self: false,
          detail: "80/TCP",
          via: null,
          urls: [],
          publishedAt: null,
        },
        {
          at: "published",
          published: {
            service: ref("Service", "payments"),
            ports: [{ name: "http", port: 80 }],
            ready: 0,
            whole: true,
          },
          tone: "warn",
        } as never,
      ])
    );

    const payments = entries.find((entry) => entry.label === "payments");
    expect(payments?.servingKnown).toBe(true);
    expect(payments?.serving).toBe(false);
  });

  /**
   * A Services or Ingresses list the cluster refused is named in
   * `notLookedAt`, and without reading it the page states "nothing publishes
   * this" over a list nobody read.
   */
  it("does not claim to know the ways in when a list was refused", () => {
    const { known } = entryPointsOf(
      conns({
        notLookedAt: [
          { kind: "Service", version: "v1", reason: "forbidden" },
        ] as never,
      }),
      []
    );
    expect(known).toBe(false);
  });
});

describe("what is still open", () => {
  it("passes on every kind the read admits it did not look at", () => {
    const unread = openQuestionsOf(
      conns({
        notLookedAt: [{ kind: "Ingress", why: { says: "nodeClaimsNotRead" } }],
      })
    );
    expect(unread).toEqual([
      { kind: "Ingress", why: { says: "nodeClaimsNotRead" } },
    ]);
    expect(openQuestionsOf(undefined)).toEqual([]);
  });

  it("keeps only this service's journal entries, newest first", () => {
    const entry = (name: string, at: number): JournalEntry => ({
      id: `${name}-${at}`,
      context: "prod",
      kind: "Deployment",
      namespace: "shop",
      name,
      at,
      field: "image",
      key: "0",
      from: "a",
      to: "b",
    });
    const mine = changesFor(
      [entry("payments", 1), entry("carts", 2), entry("payments", 3)],
      {
        context: "prod",
        kind: "Deployment",
        namespace: "shop",
        name: "payments",
      }
    );
    expect(mine.map((item) => item.at)).toEqual([3, 1]);
  });

  it("keeps only the open questions asked about this service", () => {
    const watch = (name: string, status: Watch["status"]): Watch => ({
      id: name,
      context: "prod",
      kind: "Deployment",
      namespace: "shop",
      name,
      ask: "rollout",
      startedAt: 1,
      status,
      baseline: null,
    });
    const open = waitingFor(
      [
        watch("payments", { state: "watching" }),
        watch("payments-old", { state: "watching" }),
        watch("payments-done", { state: "expired" }),
      ],
      {
        context: "prod",
        kind: "Deployment",
        namespace: "shop",
        name: "payments",
      }
    );
    expect(open).toHaveLength(1);
    expect(open[0].status.state).toBe("watching");
  });

  /**
   * A Deployment and a Job of the same name in the same namespace are two
   * objects. The match was on context, namespace and name alone, so one's
   * wait was shown on the other's card — while both its neighbours,
   * `changesFor` and `pinKey`, match on the kind too.
   */
  it("does not show one kind's wait on another kind's card", () => {
    const job: Watch = {
      id: "j",
      context: "prod",
      kind: "Job",
      namespace: "shop",
      name: "payments",
      ask: "jobOutcome",
      startedAt: 1,
      status: { state: "watching" },
      baseline: null,
    };
    expect(
      waitingFor([job], {
        context: "prod",
        kind: "Deployment",
        namespace: "shop",
        name: "payments",
      })
    ).toHaveLength(0);
  });
});

describe("pins", () => {
  it("keys a pin by kind, namespace and name", () => {
    expect(
      pinKey({ kind: "Deployment", namespace: "shop", name: "payments" })
    ).toBe("Deployment/shop/payments");
  });

  it("budgets the cards, because each one is a neighbourhood read", () => {
    expect(MAX_PINNED_PER_CONTEXT).toBeGreaterThan(0);
    expect(MAX_PINNED_PER_CONTEXT).toBeLessThanOrEqual(20);
  });
});
