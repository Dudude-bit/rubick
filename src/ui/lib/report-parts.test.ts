import { describe, expect, it } from "vite-plus/test";

import type { ResourceConnections } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { changesCount, timelineOf, type JournalEntry } from "./changes";
import { VALUE_CLOSE, VALUE_OPEN } from "./report";
import {
  changesSection,
  conditionsSection,
  eventsSection,
  placed,
  refOf,
  slugOf,
  unreadLines,
  utcMoment,
  ORDER,
  type PlacedSection,
} from "./report-parts";
import { graphSections } from "./report-graph";
import { connectionCount } from "./connections";

const t = ((section: string, key: string, values?: Record<string, unknown>) =>
  values
    ? `${section}.${key}(${Object.entries(values)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(",")})`
    : `${section}.${key}`) as unknown as T;

const subject = {
  kind: "Pod",
  name: "payments-7b6d9c5f4-x8k2p",
  namespace: "shop",
};

/** The pod as its page hands it to the frame: owned by the Deployment's ReplicaSet. */
const owned = {
  ...subject,
  owners: [{ kind: "ReplicaSet", name: "payments-7b6d9c5f4" }],
};

const read = (over: Partial<ResourceConnections> = {}) => ({
  data: {
    subject: { ...subject, existence: "present", facts: null },
    edges: [],
    stops: [],
    published: [],
    notLookedAt: [],
    ...over,
  } as ResourceConnections,
  error: null,
  isPending: false,
});

const values = (text: string) =>
  text.replaceAll(VALUE_OPEN, "[").replaceAll(VALUE_CLOSE, "]");

describe("graphSections", () => {
  /**
   * hello-web's Share dialog said "Connections 6" beside the page's tab
   * "Connections 5": the file counted rows, the tab objects, and the row
   * that says nothing owns the Deployment is not an object. Fails if the two
   * stop counting the same thing.
   */
  it("counts what the Connections tab counts: the objects, not the rows", () => {
    const deployment = {
      kind: "Deployment",
      name: "hello-web",
      namespace: "lena-sandbox",
      existence: "present",
      facts: null,
    } as const;
    const replicaSet = {
      kind: "ReplicaSet",
      name: "hello-web-5d8f7b9c6",
      namespace: "lena-sandbox",
      existence: "present",
      facts: null,
    } as const;
    const data = {
      subject: deployment,
      edges: [
        {
          from: deployment,
          to: replicaSet,
          relation: { verb: "owns", controller: true },
        },
      ],
      stops: [],
      published: [],
      notLookedAt: [],
    } as unknown as ResourceConnections;
    const connections = graphSections(
      { data, error: null, isPending: false },
      t,
      false
    ).sections.find((section) => section.id === "connections")!;
    const body = connections.body as { groups: { rows: unknown[] }[] };
    expect(
      body.groups.reduce((sum, group) => sum + group.rows.length, 0)
    ).toBeGreaterThan(connectionCount(data));
    expect(connections.count).toBe(connectionCount(data));
  });

  /**
   * Marco's ledger: the Share dialog said "Connections 0" over five kinds
   * the app never looked at. Fails if a count beside kinds not looked at is
   * handed over as the whole.
   */
  it("says the count is part where some kinds were not looked at", () => {
    const why = {
      says: "unanswered",
      version: "v1",
      said: "forbidden",
    } as const;
    const connections = graphSections(
      read({
        notLookedAt: [
          { kind: "Pod", why },
          { kind: "Ingress", why },
        ],
      }),
      t,
      false
    ).sections.find((section) => section.id === "connections")!;
    expect(connections.partial).toBe("count.kindsNotLookedAt(n=2)");
    expect(
      graphSections(read(), t, false).sections.find(
        (section) => section.id === "connections"
      )!.partial
    ).toBeNull();
  });

  /**
   * An empty chain and a chain nobody could read are opposite answers. The
   * file printed "Nothing here." for both, so a colleague concluded nothing
   * is wired to this pod at the moment the page said it could not read.
   */
  it("says the graph could not be read instead of drawing an empty one", () => {
    const { sections, unread } = graphSections(
      { data: undefined, error: new Error("forbidden"), isPending: false },
      t,
      true
    );
    expect(unread).toBe("empty.couldNotReadWhatConnects");
    expect(sections.every((section) => section.unread === unread)).toBe(true);
  });

  /** A read still running is not a read that failed. */
  it("tells a graph still being read from one that was refused", () => {
    const { unread } = graphSections(
      { data: undefined, error: null, isPending: true },
      t,
      true
    );
    expect(unread).toBe("share.chainStillReading");
  });

  /**
   * Where the path stops is the sharpest thing the graph knows, and the file
   * listed the edges only, so a Service that publishes no endpoint arrived
   * as an ordinary working hop.
   */
  it("carries a stop no path reached, as a broken path ending in red", () => {
    const { sections } = graphSections(
      read({
        stops: [
          {
            reason: "selectsNothing",
            service: {
              kind: "Service",
              name: "shop-db-rw",
              namespace: "shop",
              existence: "present",
              facts: null,
            },
            selector: "app=db",
          },
        ] as never,
      }),
      t,
      true
    );
    const traffic = sections.find((section) => section.id === "traffic")!;
    expect(traffic.body.type).toBe("traffic");
    const path = traffic.body.type === "traffic" ? traffic.body.paths[0] : null;
    expect(path?.broken).toBe(true);
    expect(path?.hops[0].ref).toMatchObject({
      kind: "Service",
      stem: "shop-db-rw",
    });
    expect(path?.hops.at(-1)?.tone).toBe("err");
  });

  /** A Gateway API stop carries a `route`, and the old guess looked for neither of its names. */
  it("names the object a Gateway API stop is about", () => {
    const { sections } = graphSections(
      read({
        stops: [
          {
            reason: "routeNotAccepted",
            route: {
              kind: "HTTPRoute",
              name: "shop",
              namespace: "shop",
              existence: "present",
              facts: null,
            },
            gateway: {
              kind: "Gateway",
              name: "public",
              namespace: "infra",
              existence: "present",
              facts: null,
            },
            conditionReason: "NotAllowedByListeners",
            message: null,
          },
        ] as never,
      }),
      t,
      true
    );
    const traffic = sections.find((section) => section.id === "traffic")!;
    const hop =
      traffic.body.type === "traffic" ? traffic.body.paths[0].hops[0] : null;
    expect(hop?.ref).toMatchObject({ kind: "HTTPRoute", stem: "shop" });
  });
});

describe("what the graph says about objects it could not check", () => {
  const object = (
    kind: string,
    name: string,
    existence: "present" | "missing" | "notChecked" = "present"
  ) => ({ kind, name, namespace: "shop", existence, facts: null }) as never;

  /**
   * An Ingress whose Service could not be looked up: the page draws that hop
   * amber with "not checked", and the file drew an unbroken path through a
   * plain Service, the same as one that exists.
   */
  it("draws a hop it could not check as not checked, not as a working one", () => {
    const ingress = object("Ingress", "shop");
    const { sections } = graphSections(
      {
        data: {
          subject: ingress,
          edges: [
            {
              from: ingress,
              to: object("Service", "shop", "notChecked"),
              relation: {
                verb: "routes",
                host: "shop.example.com",
                path: "/",
                pathType: "Prefix",
                port: "80",
                tls: false,
              },
            },
          ],
          stops: [],
          published: [],
          notLookedAt: [],
        } as ResourceConnections,
        error: null,
        isPending: false,
      },
      t,
      true
    );
    const traffic = sections.find((section) => section.id === "traffic")!;
    const hops =
      traffic.body.type === "traffic" ? traffic.body.paths[0].hops : [];
    const service = hops.find((hop) => hop.ref?.kind === "Service");
    expect(service?.tone).toBe("warn");
    expect(service?.detail).toContain("nav.notChecked");
  });

  /**
   * A pod stuck because its ConfigMap does not exist: the Connections tab
   * tags that row red. Without the tag the file lists it like a present one
   * and sends the colleague away from the cause.
   */
  it("tags a connection that is missing, and one it could not check", () => {
    const deployment = object("Deployment", "web");
    const usage = {
      how: "mount",
      container: "app",
      path: "/etc/app",
      readOnly: true,
      subPath: null,
      volume: "cfg",
      projected: false,
    };
    const { sections } = graphSections(
      {
        data: {
          subject: deployment,
          edges: [
            {
              from: deployment,
              to: object("ConfigMap", "gone", "missing"),
              relation: { verb: "uses", usages: [usage] },
            },
            {
              from: deployment,
              to: object("Secret", "unread", "notChecked"),
              relation: { verb: "uses", usages: [usage] },
            },
          ],
          stops: [],
          published: [],
          notLookedAt: [],
        } as unknown as ResourceConnections,
        error: null,
        isPending: false,
      },
      t,
      true
    );
    const connections = sections.find((s) => s.id === "connections")!;
    const rows =
      connections.body.type === "connections"
        ? connections.body.groups.flatMap((group) => group.rows)
        : [];
    const byName = (name: string) =>
      rows.find((row) => row.ref && row.ref.stem + row.ref.tail === name);
    expect(byName("gone")).toMatchObject({
      existence: "nav.notInThisNamespace",
      missing: true,
    });
    expect(byName("unread")).toMatchObject({ existence: "nav.notChecked" });
  });

  /**
   * On the page a certificate not read back yet is "reading…" for a moment;
   * in a file that moment is for good, and a hop drawn with no warning read
   * as a certificate that is fine.
   */
  it("draws a certificate it has not read as not checked", () => {
    const deployment = object("Deployment", "web");
    const svc = object("Service", "web");
    const ingress = object("Ingress", "web");
    const data = {
      subject: deployment,
      edges: [
        {
          from: svc,
          to: deployment,
          relation: { verb: "selects", selector: "app=web" },
        },
        {
          from: ingress,
          to: svc,
          relation: {
            verb: "routes",
            host: "web.example.com",
            path: "/",
            pathType: "Prefix",
            port: "80",
            tls: true,
          },
        },
      ],
      stops: [],
      published: [],
      notLookedAt: [],
    } as unknown as ResourceConnections;
    const routing = new Map([
      [
        "Ingress/shop/web",
        {
          tls: [{ secretName: "web-tls", hosts: ["web.example.com"] }],
          addresses: [],
          binding: null,
        },
      ],
    ]) as never;
    const { sections } = graphSections(
      { data, error: null, isPending: false },
      t,
      true,
      { routing }
    );
    const traffic = sections.find((section) => section.id === "traffic")!;
    const hops =
      traffic.body.type === "traffic" ? traffic.body.paths[0].hops : [];
    const certificate = hops.find((hop) => hop.ref?.kind === "Secret");
    expect(certificate?.tone).toBe("warn");
    expect(certificate?.detail).toContain("nav.notChecked");
  });

  /**
   * A Secret has no path traffic takes to it. Its report said no Service
   * selects "these pods", so traffic never reaches "this object (Secret)".
   */
  it("draws no traffic for a kind whose page draws no chain", () => {
    const { sections } = graphSections(read(), t, false);
    expect(sections.map((section) => section.id)).toEqual(["connections"]);
  });
});

describe("utcMoment", () => {
  /**
   * The sentence is in the reader's language and the moment was written in
   * the sender's: "с 28 Sep at 23:57" in a Russian file. Digits carry none.
   */
  it("writes a moment in digits and UTC, with no month name to translate", () => {
    expect(utcMoment(Date.UTC(2026, 8, 28, 23, 57, 12))).toBe(
      "2026-09-28 23:57 UTC"
    );
  });
});

describe("unreadLines", () => {
  const section = (title: string, unread: string | null): PlacedSection => ({
    id: title,
    order: ORDER.own,
    title,
    icon: "",
    unread,
    body: { type: "text", text: "" },
  });

  /**
   * A section that says in place it could not be read has to be in the
   * summary too: the Node report said "Pods tab not opened" under a footer
   * saying everything was read.
   */
  it("says every section that could not be read, once per reason", () => {
    expect(
      unreadLines([
        section("Traffic", "still reading"),
        section("Connections", "still reading"),
        section("Pods on this node", "Pods tab not opened"),
        section("Events", null),
      ])
    ).toEqual([
      "Traffic, Connections: still reading",
      "Pods on this node: Pods tab not opened",
    ]);
  });
});

describe("changesSection", () => {
  const at = Date.parse("2026-09-21T17:14:55Z");
  const AT = "2026-09-21T18:00:00Z";
  /** Watched the whole window, so no gap rows get in the way of the others. */
  const WATCHED = [
    {
      from: Date.parse(AT) - 8 * 24 * 60 * 60_000,
      seenAt: Date.parse(AT),
      to: null,
    },
  ];
  const entry = (over: Partial<JournalEntry>): JournalEntry =>
    ({
      id: String(Math.random()),
      at,
      context: "prod-eu",
      namespace: "shop",
      kind: "Deployment",
      name: "payments",
      field: "image",
      key: "app",
      from: "a",
      to: "b",
      ...over,
    }) as JournalEntry;

  /**
   * The journal is global. A session spent watching another cluster made it
   * non-empty, and the hedge that says this app was never watching here
   * disappeared.
   */
  it("still says it was not watching when the journal is another cluster's", () => {
    const section = changesSection(
      { entries: [entry({ context: "staging-eu" })], spans: [] },
      "prod-eu",
      owned,
      AT,
      t
    );
    expect(section?.body).toMatchObject({
      type: "changes",
      changes: [{ at: null }],
    });
  });

  /** A span the cluster refused DaemonSets in watched no DaemonSet; drawn quiet, it hid that. */
  it("says it was not watching a kind the span was refused", () => {
    const section = changesSection(
      { entries: [], spans: [{ ...WATCHED[0], unwatched: ["DaemonSet"] }] },
      "prod-eu",
      { kind: "DaemonSet", name: "agent", namespace: "shop", owners: [] },
      AT,
      t
    );
    expect(section?.body).toMatchObject({
      type: "changes",
      changes: [{ at: null, parts: [{ text: "share.journalEmpty" }] }],
    });
  });

  /** Hours scoped to another namespace are not hours this object was watched. */
  it("says it was not watching an object outside the span's namespaces", () => {
    const section = changesSection(
      { entries: [], spans: [{ ...WATCHED[0], scope: ["kube-system"] }] },
      "prod-eu",
      owned,
      AT,
      t
    );
    expect(section?.body).toMatchObject({
      changes: [{ at: null, parts: [{ text: "share.journalEmpty" }] }],
    });
  });

  /**
   * One rollout wrote two journal rows with one stamp, and the file printed
   * both with the full image reference twice: the tag that changed was the
   * last twelve characters of a hundred.
   */
  it("puts one rollout under one time, the image first and only its tags", () => {
    const section = changesSection(
      {
        entries: [
          entry({ field: "generation", key: null, from: "84", to: "86" }),
          entry({
            from: "registry.example/shop/payments:2.19.0",
            to: "registry.example/shop/payments:2.21.0",
          }),
        ],
        spans: WATCHED,
      },
      "prod-eu",
      owned,
      AT,
      t
    );
    const changes =
      section?.body.type === "changes" ? section.body.changes : [];
    expect(changes).toHaveLength(1);
    expect(changes[0].ref).toMatchObject({
      kind: "Deployment",
      stem: "payments",
    });
    expect(changes[0].parts.map((part) => values(part.text))).toEqual([
      "changes.journalImage(container=app,from=[2.19.0],to=[2.21.0])",
      "changes.journalGeneration(from=[84],to=[86])",
    ]);
  });

  /**
   * Lena's hello-web: the Changes tab said 15 and the Share dialog "What
   * changed 7": the dialog counted rows, each of which holds every change of
   * one moment, while the tab counts changes. Fails if the file's count
   * stops being the number of changes the tab says it saw.
   */
  it("counts the changes the Changes tab saw, not the moments they fell in", () => {
    const entries = [
      entry({ field: "generation", key: null, from: "1", to: "2" }),
      entry({ field: "replicas", key: null, from: "1", to: "2" }),
      entry({
        at: at + 60_000,
        field: "generation",
        key: null,
        from: "2",
        to: "3",
      }),
      entry({
        at: at + 60_000,
        field: "replicas",
        key: null,
        from: "2",
        to: "1",
      }),
      entry({ at: at + 120_000, field: "image" }),
    ];
    const section = changesSection(
      { entries, spans: WATCHED },
      "prod-eu",
      { kind: "Deployment", name: "payments", namespace: "shop", owners: [] },
      AT,
      t
    );
    const tab = timelineOf({
      revisions: [],
      deliveries: [],
      helm: [],
      journal: entries,
      spans: WATCHED,
      window: {
        from: Date.parse(AT) - 7 * 24 * 60 * 60_000,
        to: Date.parse(AT),
      },
      createdAt: null,
    });
    const rows = section?.body.type === "changes" ? section.body.changes : [];
    expect(rows).toHaveLength(3);
    expect(section?.count).toBe(5);
    expect(changesCount(tab, t)).toBe(
      "count.changesSeen(n=" + String(section?.count) + ")"
    );
  });

  /** The object itself, not only what owns it: a Deployment's page shares its own journal. */
  it("reads the subject's own entries when the subject is the watched kind", () => {
    const section = changesSection(
      { entries: [entry({})], spans: WATCHED },
      "prod-eu",
      { kind: "Deployment", name: "payments", namespace: "shop", owners: [] },
      AT,
      t
    );
    expect(section?.count).toBe(1);
  });

  /**
   * The journal watches three kinds. A ConfigMap's report said "What
   * changed — Nothing here.", a claim about an object nobody was watching.
   */
  it("says nothing about changes to an object no watched workload owns", () => {
    expect(
      changesSection(
        { entries: [entry({})], spans: WATCHED },
        "prod-eu",
        { kind: "ConfigMap", name: "payments", namespace: "shop", owners: [] },
        AT,
        t
      )
    ).toBeNull();
  });

  /**
   * By name prefix, `web-worker-7d9f8b6c4-x2x9z` belonged to Deployment
   * `web` as much as to `web-worker`, and the file listed `web`'s rollout as
   * this pod's.
   */
  it("reads the owner from ownerReferences, not from a name that starts the same", () => {
    const section = changesSection(
      {
        entries: [
          entry({ name: "web", from: "web:1", to: "web:2" }),
          entry({ name: "web-worker", from: "worker:1", to: "worker:2" }),
        ],
        spans: WATCHED,
      },
      "prod-eu",
      {
        kind: "Pod",
        name: "web-worker-7d9f8b6c4-x2x9z",
        namespace: "shop",
        owners: [{ kind: "ReplicaSet", name: "web-worker-7d9f8b6c4" }],
      },
      AT,
      t
    );
    const refs =
      section?.body.type === "changes"
        ? section.body.changes.flatMap((change) =>
            change.ref ? [change.ref.stem + change.ref.tail] : []
          )
        : [];
    expect(refs).toEqual(["web-worker"]);
  });

  /**
   * The Changes screen draws a stretch nobody watched as a row, so it is not
   * read as a stretch nothing happened; the object's report dropped it.
   */
  it("draws a stretch the app was not watching as a row of its own", () => {
    const section = changesSection(
      {
        entries: [entry({})],
        spans: [
          {
            from: Date.parse(AT) - 2 * 60 * 60_000,
            seenAt: Date.parse(AT) - 60 * 60_000,
            to: Date.parse(AT) - 60 * 60_000,
          },
        ],
      },
      "prod-eu",
      owned,
      AT,
      t
    );
    const texts =
      section?.body.type === "changes"
        ? section.body.changes.flatMap((change) =>
            change.parts.map((part) => part.text)
          )
        : [];
    expect(texts.some((text) => text.startsWith("changes.notObserved("))).toBe(
      true
    );
  });
});

describe("the rest of the parts", () => {
  /** Warnings are what the colleague came for; they go first. */
  it("puts warnings before normal events", () => {
    const section = eventsSection(
      [
        {
          type: "Normal",
          reason: "Pulled",
          message: "ok",
          lastTimestamp: "2026-09-21T18:00:00Z",
          involvedObject: { kind: "Pod", name: "p" },
          namespace: "shop",
        },
        {
          type: "Warning",
          reason: "BackOff",
          message: "restarting",
          lastTimestamp: "2026-09-21T17:00:00Z",
          involvedObject: { kind: "Pod", name: "p" },
          namespace: "shop",
        },
      ] as never,
      null
    );
    expect(section.body.type === "events" && section.body.rows[0].reason).toBe(
      "BackOff"
    );
  });

  /** A pressure condition that is False is healthy; reading True as good would paint it red. */
  it("gives each condition the role the Conditions tab gives it", () => {
    const section = conditionsSection(
      [
        {
          type: "MemoryPressure",
          status: "False",
          reason: null,
          message: null,
          lastTransitionTime: null,
        },
      ],
      t
    );
    expect(section.body).toMatchObject({
      type: "conditions",
      rows: [{ role: "ok" }],
    });
  });

  it("sorts sections by where they belong, keeping a page's own order among equals", () => {
    const at = (id: string, order: number) => ({
      id,
      order,
      title: id,
      icon: "",
      body: { type: "text" as const, text: id },
    });
    expect(
      placed([
        at("logs", ORDER.logs),
        at("a", ORDER.own),
        at("b", ORDER.own),
        at("events", ORDER.events),
      ]).map((section) => section.id)
    ).toEqual(["a", "b", "events", "logs"]);
  });

  /** Two tables or lists with one title each became `<section id="table">` twice. */
  it("gives every section its own id when two arrive with the same one", () => {
    const at = (id: string) => ({
      id,
      order: ORDER.own,
      title: id,
      icon: "",
      body: { type: "text" as const, text: id },
    });
    expect(
      placed([at("table"), at("table"), at("events")]).map(
        (section) => section.id
      )
    ).toEqual(["table", "table-2", "events"]);
  });

  /** A Russian title kept only `[a-z0-9]` and became an empty id. */
  it("makes an id from a title in any script and never an empty one", () => {
    expect(slugOf("Маршруты")).toBe("маршруты");
    expect(slugOf("Сертификаты и издатели")).toBe("сертификаты-и-издатели");
    expect(slugOf("Routes")).toBe("routes");
    expect(slugOf("…")).toBe("section");
  });

  /** The tail carries identity only when it is long enough to; a node's `-0` is not. */
  it("splits a generated name the way the app does", () => {
    expect(refOf(subject)).toMatchObject({
      stem: "payments",
      tail: "-7b6d9c5f4-x8k2p",
    });
  });
});
