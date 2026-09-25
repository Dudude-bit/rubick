import { describe, expect, it } from "vitest";

import type { ResourceConnections } from "@/generated/types";
import type { T } from "@/i18n/useT";
import type { JournalEntry } from "./changes";
import { VALUE_CLOSE, VALUE_OPEN } from "./report";
import {
  changesSection,
  conditionsSection,
  eventsSection,
  placed,
  refOf,
  slugOf,
  ORDER,
} from "./report-parts";
import { graphSections } from "./report-graph";

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
   * An empty chain and a chain nobody could read are opposite answers. The
   * file printed "Nothing here." for both, so a colleague concluded nothing
   * is wired to this pod at the moment the page said it could not read.
   */
  it("says the graph could not be read instead of drawing an empty one", () => {
    const { sections, unread } = graphSections(
      { data: undefined, error: new Error("forbidden"), isPending: false },
      t
    );
    expect(unread).toBe("empty.couldNotReadWhatConnects");
    expect(sections.every((section) => section.unread === unread)).toBe(true);
  });

  /** A read still running is not a read that failed. */
  it("tells a graph still being read from one that was refused", () => {
    const { unread } = graphSections(
      { data: undefined, error: null, isPending: true },
      t
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
      t
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
      t
    );
    const traffic = sections.find((section) => section.id === "traffic")!;
    const hop =
      traffic.body.type === "traffic" ? traffic.body.paths[0].hops[0] : null;
    expect(hop?.ref).toMatchObject({ kind: "HTTPRoute", stem: "shop" });
  });
});

describe("changesSection", () => {
  const at = Date.parse("2026-09-21T17:14:55Z");
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
      [entry({ context: "staging-eu" })],
      "prod-eu",
      subject,
      t
    );
    expect(section.body).toMatchObject({
      type: "changes",
      changes: [{ at: null }],
    });
  });

  /**
   * One rollout wrote two journal rows with one stamp, and the file printed
   * both with the full image reference twice: the tag that changed was the
   * last twelve characters of a hundred.
   */
  it("puts one rollout under one time, the image first and only its tags", () => {
    const section = changesSection(
      [
        entry({ field: "generation", key: null, from: "84", to: "86" }),
        entry({
          from: "registry.example/shop/payments:2.19.0",
          to: "registry.example/shop/payments:2.21.0",
        }),
      ],
      "prod-eu",
      subject,
      t
    );
    const changes = section.body.type === "changes" ? section.body.changes : [];
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

  /** The object itself, not only what owns it: a Deployment's page shares its own journal. */
  it("reads the subject's own entries when the subject is the watched kind", () => {
    const section = changesSection(
      [entry({})],
      "prod-eu",
      { kind: "Deployment", name: "payments", namespace: "shop" },
      t
    );
    expect(section.count).toBe(1);
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
