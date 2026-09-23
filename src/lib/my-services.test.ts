import { describe, expect, it } from "vitest";

import {
  CARD_REFRESH,
  changesFor,
  entryPointsOf,
  MAX_PINNED_PER_CONTEXT,
  isPinned,
  openQuestionsOf,
  pinKey,
  pinsOf,
  stateOf,
  waitingFor,
} from "./my-services";
import { REFRESH_INTERVALS } from "./refresh";
import type { ChainHop, ChainPath } from "./connections";
import type { JournalEntry } from "./changes";
import type { Watch } from "./tell-me-when";
import type {
  ObjectRef,
  ResourceConnections,
  ServicePublished,
} from "@/generated/types";

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

/** What the commands wrapper throws: the backend's `{code, message}` as the cause. */
function failed(code: string, message: string): Error {
  return new Error(
    `Tauri command 'getResourceConnections' failed: ${message}`,
    {
      cause: { code, message },
    }
  );
}

describe("stateOf", () => {
  /**
   * The code decides, not the sentence. The card matched "resource not
   * found" in English, and a deleted Deployment's 404 said something else,
   * so it drew "could not read" over a service that is gone.
   */
  it("reads a deletion off the error's code", () => {
    const pin = { kind: "Deployment", name: "payments" };
    const said = "Resource not found: Deployment/payments in namespace shop";

    expect(stateOf(undefined, failed("NOT_FOUND", said), pin).state).toBe(
      "gone"
    );
    expect(stateOf(undefined, failed("LIST_UNREAD", said), pin)).toEqual({
      state: "unread",
      why: said,
    });
  });

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
      stateOf(
        undefined,
        failed(
          "NOT_FOUND",
          "Resource not found: Deployment/payments in namespace shop"
        )
      )
    ).toEqual({
      state: "gone",
    });
    const unread = stateOf(
      undefined,
      failed(
        "PERMISSION_DENIED",
        "Permission denied: deployments.apps is forbidden"
      )
    );
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
      stateOf(conns(), failed("PERMISSION_DENIED", "services is forbidden"), {
        kind: "Deployment",
        name: "payments",
      }).state
    ).toBe("unread");
  });

  /**
   * A lost connection is this app failing, not the cluster answering.
   * Reading it as a deleted workload sends somebody to rebuild something
   * that is still running.
   */
  it("calls a workload gone only when the cluster said so about it", () => {
    const pin = { kind: "Deployment", name: "payments" };
    expect(
      stateOf(undefined, failed("NOT_CONNECTED", "Not connected to prod"), pin)
        .state
    ).toBe("unread");
    expect(
      stateOf(
        undefined,
        failed(
          "NOT_FOUND",
          "Resource not found: Deployment/payments in namespace shop"
        ),
        pin
      ).state
    ).toBe("gone");
  });

  /**
   * The name matters as much as the words: "Resource not found" about the
   * neighbour a chain walked into is the cluster answering about something
   * else, and drawing this card as deleted sends somebody to rebuild what
   * is still running.
   */
  it("does not call this workload gone because another one is", () => {
    expect(
      stateOf(
        undefined,
        failed(
          "NOT_FOUND",
          "Resource not found: Deployment/checkout in namespace shop"
        ),
        { kind: "Deployment", name: "payments" }
      ).state
    ).toBe("unread");
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

  /**
   * A neighbourhood read walks into the objects around this one, so its
   * 404 may be about any of them. Matching the name alone marked a pinned
   * `Deployment/payments` deleted because a `Service/payments` beside it
   * was — and sent somebody to recreate what was still running.
   */
  it("does not call this workload gone because a namesake of another kind is", () => {
    const pin = { kind: "Deployment", name: "payments" };

    expect(
      stateOf(
        undefined,
        failed(
          "NOT_FOUND",
          "Resource not found: Service/payments in namespace shop"
        ),
        pin
      ).state
    ).toBe("unread");

    expect(
      stateOf(
        undefined,
        failed(
          "NOT_FOUND",
          "Resource not found: Deployment/payments in namespace shop"
        ),
        pin
      ).state
    ).toBe("gone");
  });

  /**
   * A name is data, not a pattern. `payments.v1` matched `paymentsXv1`
   * because the dot went into a `RegExp` unescaped, and a value carrying a
   * bracket threw where it was built.
   */
  it("reads a name with a dot in it as that name and no other", () => {
    const pin = { kind: "Deployment", name: "payments.v1" };

    expect(
      stateOf(
        undefined,
        failed(
          "NOT_FOUND",
          "Resource not found: Deployment/paymentsXv1 in shop"
        ),
        pin
      ).state
    ).toBe("unread");

    expect(
      stateOf(
        undefined,
        failed(
          "NOT_FOUND",
          "Resource not found: Deployment/payments.v1 in shop"
        ),
        pin
      ).state
    ).toBe("gone");

    // And a name no regex would survive is read, not thrown on.
    expect(() =>
      stateOf(
        undefined,
        failed("NOT_FOUND", "Resource not found: Deployment/weird[ in shop"),
        { kind: "Deployment", name: "weird[" }
      )
    ).not.toThrow();
  });

  /**
   * Either half alone is enough: the pin says what was pinned, the read says
   * what the cluster answered about, and a card whose read has not caught up
   * with the other must not go green on nothing.
   */
  it("holds the CronJob rule whichever half names the kind", () => {
    const facts = {
      kind: "workload",
      replicas: 0,
      readyReplicas: 0,
      revision: null,
      current: null,
    };
    const byRead = conns({
      subject: {
        kind: "CronJob",
        name: "nightly",
        namespace: "shop",
        existence: "present",
        facts,
      } as never,
    });
    const byPin = conns({
      subject: { ...conns().subject, name: "nightly", facts } as never,
    });

    expect(
      stateOf(byRead, null, { kind: "Deployment", name: "nightly" }).state
    ).toBe("unread");
    expect(
      stateOf(byPin, null, { kind: "CronJob", name: "nightly" }).state
    ).toBe("unread");
  });

  /**
   * A subject the read could not describe as a workload has no replicas to
   * count; counting them anyway compared two undefined numbers and drew the
   * card short of nothing.
   */
  it("says nothing about a subject the read did not describe as a workload", () => {
    const other = conns({
      subject: {
        ...conns().subject,
        facts: { kind: "service", clusterIp: "10.0.0.1" },
      } as never,
    });
    expect(stateOf(other, null).state).toBe("unread");
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
    // An address is an address. Whether anything answers on it is the
    // published hop's answer, and claiming to know here draws "nothing
    // behind it" in warning colours over a question nobody asked.
    expect(entries[0].servingKnown).toBe(false);
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
            stop: null,
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

describe("more ways in", () => {
  const chain = (hops: ChainPath["hops"]): ChainPath[] => [
    { key: "c", hops, broken: false },
  ];

  /**
   * A chain walks through the workload and its pods as well as the Services
   * in front of it. Only a Service is a way in; listing the rest offered a
   * Deployment as somewhere to send traffic.
   */
  it("offers only the objects traffic can actually arrive at", () => {
    const { entries } = entryPointsOf(
      conns(),
      chain([
        {
          at: "object",
          object: ref("Pod", "payments-7f4d9c6b5-abcde"),
          self: true,
          detail: null,
          via: null,
          urls: [],
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
    expect(entries.map((entry) => entry.label)).toEqual(["payments"]);
  });

  /**
   * A card's neighbourhood is a summary: three ready addresses arrive as one
   * with `whole: false`. Reading `whole` as "the counts were partial" put
   * "not read yet" on every Service with more than one replica.
   */
  it("knows a service with several replicas is serving from its summary", () => {
    const { entries } = entryPointsOf(
      conns(),
      chain([publishedHop({ ready: 3, whole: false })])
    );
    expect(entries[0]).toMatchObject({ serving: true, servingKnown: true });
  });

  /** Down to draining addresses is a restart: kube-proxy still sends there,
   *  and the traffic chain beside the card says so. */
  it("calls a service with only draining addresses still serving", () => {
    const { entries } = entryPointsOf(
      conns(),
      chain([publishedHop({ draining: 1 })])
    );
    expect(entries[0].serving).toBe(true);
  });

  /** Neither the endpoints nor the pods answered: the zeros are nobody's. */
  it("does not claim nothing is behind a service nobody could read", () => {
    const { entries } = entryPointsOf(
      conns(),
      chain([publishedHop({ source: "podReadiness" })])
    );
    expect(entries[0]).toMatchObject({ serving: false, servingKnown: false });
  });
});

function publishedHop(over: Partial<ServicePublished>): ChainHop {
  return {
    at: "published",
    published: {
      service: ref("Service", "payments"),
      source: "slices",
      slices: 1,
      ready: 0,
      draining: 0,
      notReady: 0,
      unrouted: 0,
      ports: [],
      endpoints: [],
      whole: true,
      unpublished: [],
      stop: null,
      ...over,
    },
    first: null,
    address: null,
    summary: "",
    tone: "on",
  };
}

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
      [
        entry("payments", 1),
        entry("carts", 2),
        entry("payments", 3),
        // A Job of the same name in the same namespace is another object,
        // and its image change is not this card's history.
        { ...entry("payments", 4), kind: "Job" },
      ],
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
    const answered = watch("payments", { state: "expired" });
    const open = waitingFor(
      [
        { ...watch("payments", { state: "watching" }), id: "older" },
        watch("payments-old", { state: "watching" }),
        // Same object, and the question already has an answer: a card
        // that keeps listing it is waiting for something nobody is
        // waiting for.
        { ...answered, id: "answered" },
        {
          ...watch("payments", { state: "watching" }),
          id: "newer",
          startedAt: 9,
        },
      ],
      {
        context: "prod",
        kind: "Deployment",
        namespace: "shop",
        name: "payments",
      }
    );
    // Newest question first, and the answered one gone.
    expect(open.map((item) => item.id)).toEqual(["newer", "older"]);
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

  /**
   * The home page and the Pin button each filtered the list themselves, so
   * "is this pinned" had two answers the day one of them changed. Order is
   * part of it: the page reads oldest first, and a person's first choice
   * staying first is what makes the list theirs.
   */
  it("gives one cluster's pins, oldest choice first", () => {
    const pins = [
      {
        context: "prod",
        kind: "Deployment",
        namespace: "shop",
        name: "b",
        pinnedAt: 20,
      },
      {
        context: "staging",
        kind: "Deployment",
        namespace: "shop",
        name: "c",
        pinnedAt: 5,
      },
      {
        context: "prod",
        kind: "Deployment",
        namespace: "shop",
        name: "a",
        pinnedAt: 10,
      },
    ];

    expect(pinsOf(pins, "prod").map((pin) => pin.name)).toEqual(["a", "b"]);
    expect(pinsOf(pins, null)).toEqual([]);
    expect(isPinned(pins, "prod", "Deployment/shop/a")).toBe(true);
    expect(isPinned(pins, "staging", "Deployment/shop/a")).toBe(false);
    expect(isPinned(pins, "prod", null)).toBe(false);
  });

  it("budgets the cards, because each one is a neighbourhood read", () => {
    expect(MAX_PINNED_PER_CONTEXT).toBeGreaterThan(0);
    expect(MAX_PINNED_PER_CONTEXT).toBeLessThanOrEqual(20);
  });

  /**
   * The bill is the cap times the rate, and a card's read is a whole
   * neighbourhood rather than one list. At the detail pages' rate a full
   * page asked the cluster ninety times a minute; this is what holds the
   * two numbers against each other when either moves.
   */
  it("keeps a full page of cards under thirty reads a minute", () => {
    const perMinute =
      (MAX_PINNED_PER_CONTEXT * 60_000) / REFRESH_INTERVALS[CARD_REFRESH];
    expect(perMinute).toBeLessThanOrEqual(30);
  });
});
