import { describe, expect, it } from "vitest";

import type { DeploymentContainerInfo } from "@/generated/types";
import { en } from "@/i18n/catalogue";
import { ru } from "@/i18n/ru";
import {
  diffRevisions,
  diffSnapshots,
  gapsOf,
  helmReleaseOf,
  timelineOf,
  type ObservedSpan,
  type Revision,
} from "./changes";

const T0 = Date.parse("2026-09-08T00:00:00Z");
const HOUR = 60 * 60_000;

function container(
  name: string,
  image: string,
  over: Partial<DeploymentContainerInfo> = {}
): DeploymentContainerInfo {
  return {
    name,
    image,
    phase: "app",
    ports: [],
    resources: { requests: {}, limits: {} },
    env: [],
    envFrom: [],
    ...over,
  };
}

function revision(
  number: number,
  containers: DeploymentContainerInfo[],
  over: Partial<Revision> = {}
): Revision {
  return {
    id: `rs-${number}`,
    number,
    name: `api-${number}`,
    current: false,
    at: new Date(T0 + number * HOUR).toISOString(),
    changeCause: null,
    containers,
    initContainers: [],
    templateAnnotations: {},
    templateKnown: true,
    ...over,
  };
}

describe("diffRevisions", () => {
  it("names the image, env and resource fields that differ, container by container", () => {
    const older = revision(1, [
      container("app", "app:1", {
        env: [{ name: "MODE", value: "a", valueFrom: null }],
        resources: { requests: { cpu: "100m" }, limits: {} },
      }),
      container("sidecar", "proxy:1"),
    ]);
    const newer = revision(2, [
      container("app", "app:2", {
        env: [
          { name: "MODE", value: "b", valueFrom: null },
          {
            name: "TOKEN",
            value: null,
            valueFrom: {
              sourceType: "secretKeyRef",
              name: "creds",
              key: "token",
              fieldPath: null,
              resource: null,
              optional: null,
            },
          },
        ],
        resources: { requests: { cpu: "200m" }, limits: { memory: "1Gi" } },
      }),
    ]);
    expect(diffRevisions(older, newer)).toEqual([
      { container: "app", field: "image", from: "app:1", to: "app:2" },
      { container: "app", field: "env.MODE", from: "a", to: "b" },
      {
        container: "app",
        field: "env.TOKEN",
        from: null,
        to: "secretKeyRef:creds/token",
      },
      {
        container: "app",
        field: "resources.requests.cpu",
        from: "100m",
        to: "200m",
      },
      {
        container: "app",
        field: "resources.limits.memory",
        from: null,
        to: "1Gi",
      },
      { container: "sidecar", field: "container", from: "proxy:1", to: null },
    ]);
  });

  it("carries only the checksum annotations, which are the ones a chart bumps to roll", () => {
    const older = revision(1, [container("app", "app:1")], {
      templateAnnotations: { "checksum/config": "aaa", note: "x" },
    });
    const newer = revision(2, [container("app", "app:1")], {
      templateAnnotations: { "checksum/config": "bbb", note: "y" },
    });
    expect(diffRevisions(older, newer)).toEqual([
      {
        container: null,
        field: "annotations.checksum/config",
        from: "aaa",
        to: "bbb",
      },
    ]);
  });
});

describe("diffRevisions, the fields it reads off a container", () => {
  /**
   * Reading only `name` and `key` spelled every downward-API variable
   * "fieldRef:null" — one word for `spec.nodeName` and `status.podIP` alike,
   * so a change between them was no change, and an added one printed the
   * string "null" as its new value.
   */
  it("tells two downward-API sources apart, and never prints the word null", () => {
    const from = revision(1, [
      container("app", "app:1", {
        env: [
          {
            name: "NODE",
            value: null,
            valueFrom: {
              sourceType: "fieldRef",
              name: null,
              key: null,
              fieldPath: "spec.nodeName",
              resource: null,
              optional: null,
            },
          },
        ],
      }),
    ]);
    const to = revision(2, [
      container("app", "app:1", {
        env: [
          {
            name: "NODE",
            value: null,
            valueFrom: {
              sourceType: "fieldRef",
              name: null,
              key: null,
              fieldPath: "status.podIP",
              resource: null,
              optional: null,
            },
          },
        ],
      }),
    ]);
    expect(diffRevisions(from, to)).toEqual([
      {
        container: "app",
        field: "env.NODE",
        from: "fieldRef:spec.nodeName",
        to: "fieldRef:status.podIP",
      },
    ]);
  });

  it("reads the ports and the envFrom refs a template declares", () => {
    const from = revision(1, [container("app", "app:1", { ports: [8080] })]);
    const to = revision(2, [
      container("app", "app:1", {
        ports: [8080, 9090],
        envFrom: [
          {
            prefix: null,
            configMapRef: "shop-config",
            secretRef: null,
            optional: null,
          },
        ],
      }),
    ]);
    expect(diffRevisions(from, to)).toEqual([
      { container: "app", field: "ports", from: "8080", to: "8080,9090" },
      {
        container: "app",
        field: "envFrom.0",
        from: null,
        to: "shop-config",
      },
    ]);
  });

  /** The checksum annotation is the whole point of a config-only roll. */
  it("reads the checksum annotations a chart rolls on", () => {
    expect(
      diffRevisions(
        revision(1, [container("app", "app:1")], {
          templateAnnotations: { "checksum/config": "a" },
        }),
        revision(2, [container("app", "app:1")], {
          templateAnnotations: { "checksum/config": "b" },
        })
      )
    ).toEqual([
      {
        container: null,
        field: "annotations.checksum/config",
        from: "a",
        to: "b",
      },
    ]);
  });
});

describe("gapsOf", () => {
  const span = (
    from: number,
    to: number | null,
    seenAt = to ?? from
  ): ObservedSpan => ({
    from,
    seenAt,
    to,
  });

  /** Deleting the gap arithmetic makes an unwatched night read as a calm one. */
  it("returns the stretches no span covers, including before the first and after the last", () => {
    const gaps = gapsOf(
      [span(T0 + 2 * HOUR, T0 + 4 * HOUR), span(T0 + 7 * HOUR, T0 + 8 * HOUR)],
      T0,
      T0 + 10 * HOUR
    );
    expect(gaps).toEqual([
      { from: T0, to: T0 + 2 * HOUR },
      { from: T0 + 4 * HOUR, to: T0 + 7 * HOUR },
      { from: T0 + 8 * HOUR, to: T0 + 10 * HOUR },
    ]);
  });

  /**
   * A span with no end is the one this process is still heartbeating; the
   * store closes every other one at rehydration. Ending it at `seenAt`
   * instead drew a "Not observed" box for the seconds since the last
   * heartbeat, on a cluster being watched perfectly.
   */
  it("covers to the end of the window while a span is still open", () => {
    expect(gapsOf([span(T0, null, T0 + 3 * HOUR)], T0, T0 + 5 * HOUR)).toEqual(
      []
    );
  });

  /** What a crash leaves once the store has closed it: a real gap after. */
  it("ends a closed span where it was closed", () => {
    const gaps = gapsOf(
      [span(T0, T0 + 3 * HOUR, T0 + 3 * HOUR)],
      T0,
      T0 + 5 * HOUR
    );
    expect(gaps).toEqual([{ from: T0 + 3 * HOUR, to: T0 + 5 * HOUR }]);
  });

  it("is the whole window when nothing was ever watched", () => {
    expect(gapsOf([], T0, T0 + HOUR)).toEqual([{ from: T0, to: T0 + HOUR }]);
  });
});

describe("timelineOf", () => {
  /** The gap sits on the clock among the entries, dated by its end, so a reader scrolling down meets it where it happened. */
  it("puts a gap between the entries on either side of it", () => {
    const items = timelineOf({
      revisions: [
        revision(1, [container("app", "app:1")]),
        revision(2, [container("app", "app:2")]),
      ],
      deliveries: [],
      helm: [],
      journal: [
        {
          id: "j1",
          context: "dev",
          kind: "Deployment",
          namespace: "shop",
          name: "api",
          at: T0 + 5 * HOUR,
          field: "replicas",
          key: null,
          from: "2",
          to: "3",
        },
      ],
      spans: [
        { from: T0, seenAt: T0 + 3 * HOUR, to: T0 + 3 * HOUR },
        { from: T0 + 4 * HOUR, seenAt: T0 + 6 * HOUR, to: null },
      ],
      window: { from: T0, to: T0 + 6 * HOUR },
    });
    expect(items.map((item) => item.kind)).toEqual([
      "journal",
      "gap",
      "revision",
      "revision",
    ]);
    const gap = items[1];
    expect(gap.kind === "gap" && gap.gap).toEqual({
      from: T0 + 3 * HOUR,
      to: T0 + 4 * HOUR,
    });
    const newest = items[2];
    expect(newest.kind === "revision" && newest.against).toEqual({
      state: "compared",
      missing: 0,
      changes: [
        { container: "app", field: "image", from: "app:1", to: "app:2" },
      ],
    });
    const oldest = items[3];
    expect(oldest.kind === "revision" && oldest.against).toEqual({
      state: "oldest",
    });
  });

  /**
   * `revisionHistoryLimit` deletes the ReplicaSets in between. Drawn as one
   * rollout, four rollouts' worth of changes read as a single deploy.
   */
  it("counts the revisions the cluster no longer holds between two it does", () => {
    const items = timelineOf({
      revisions: [
        revision(4, [container("app", "app:1")]),
        revision(9, [container("app", "app:4")]),
      ],
      deliveries: [],
      helm: [],
      journal: [],
      spans: [],
      window: { from: T0, to: T0 + 20 * HOUR },
    });
    const newest = items.find(
      (item) => item.kind === "revision" && item.revision.number === 9
    );
    expect(newest?.kind === "revision" && newest.against).toMatchObject({
      state: "compared",
      missing: 4,
    });
  });

  /**
   * `kubectl rollout undo` re-adopts the existing object and only bumps its
   * revision, so the newest revision carries the oldest creation time. Left
   * unsaid, the rollback is drawn as having happened before the change it
   * undid.
   */
  it("marks a revision whose object predates the revision before it", () => {
    const items = timelineOf({
      revisions: [
        revision(2, [container("app", "app:2")]),
        {
          ...revision(3, [container("app", "app:1")]),
          at: new Date(T0).toISOString(),
        },
      ],
      deliveries: [],
      helm: [],
      journal: [],
      spans: [],
      window: { from: T0, to: T0 + 20 * HOUR },
    });
    const readopted = items.find(
      (item) => item.kind === "revision" && item.revision.number === 3
    );
    expect(readopted?.kind === "revision" && readopted.readopted).toBe(true);
    const other = items.find(
      (item) => item.kind === "revision" && item.revision.number === 2
    );
    expect(other?.kind === "revision" && other.readopted).toBe(false);
  });

  /**
   * A `ControllerRevision` whose snapshot will not parse arrives with empty
   * containers. Compared like any other it reads as a revision that ran
   * nothing, and every container is reported removed.
   */
  it("says nothing about a revision whose template was not read", () => {
    const items = timelineOf({
      revisions: [
        revision(1, [container("app", "app:1")]),
        revision(2, [], { templateKnown: false }),
      ],
      deliveries: [],
      helm: [],
      journal: [],
      spans: [],
      window: { from: T0, to: T0 + 20 * HOUR },
    });
    const newest = items.find(
      (item) => item.kind === "revision" && item.revision.number === 2
    );
    expect(newest?.kind === "revision" && newest.against).toEqual({
      state: "unread",
    });
  });
});

describe("diffSnapshots", () => {
  it("reports each watched field once, and nothing when they held still", () => {
    const before = {
      generation: 3,
      images: new Map([
        ["app", "app:1"],
        ["proxy", "proxy:1"],
      ]),
      replicas: 2,
      hashes: new Map([["checksum/config", "a"]]),
    };
    expect(diffSnapshots(before, before)).toEqual([]);
    expect(
      diffSnapshots(before, {
        generation: 4,
        images: new Map([
          ["app", "app:2"],
          ["proxy", "proxy:1"],
        ]),
        replicas: 3,
        hashes: new Map([["checksum/config", "b"]]),
      })
    ).toEqual([
      { field: "generation", key: null, from: "3", to: "4" },
      { field: "image", key: "app", from: "app:1", to: "app:2" },
      { field: "replicas", key: null, from: "2", to: "3" },
      { field: "annotation", key: "checksum/config", from: "a", to: "b" },
    ]);
  });

  /**
   * Paired by position, removing the first container reported the second
   * one's image as the first one's new image, and the second as gone — two
   * changes, neither of which happened, for one that did.
   */
  it("pairs images by container name, so removing one is one change", () => {
    expect(
      diffSnapshots(
        {
          generation: 1,
          images: new Map([
            ["app", "app:1"],
            ["sidecar", "sidecar:1"],
          ]),
          replicas: 1,
          hashes: new Map(),
        },
        {
          generation: 1,
          images: new Map([["sidecar", "sidecar:1"]]),
          replicas: 1,
          hashes: new Map(),
        }
      )
    ).toEqual([{ field: "image", key: "app", from: "app:1", to: null }]);
  });
});

describe("helmReleaseOf", () => {
  it("reads the release Helm stamped, defaulting the namespace to the object's own", () => {
    expect(helmReleaseOf({}, "shop")).toBeNull();
    expect(
      helmReleaseOf({ "meta.helm.sh/release-name": "api" }, "shop")
    ).toEqual({
      name: "api",
      namespace: "shop",
    });
    expect(
      helmReleaseOf(
        {
          "meta.helm.sh/release-name": "api",
          "meta.helm.sh/release-namespace": "platform",
        },
        "shop"
      )
    ).toEqual({ name: "api", namespace: "platform" });
  });
});

describe("the words", () => {
  /**
   * Two entries an hour apart are two entries an hour apart. The page lays
   * them on one clock and stops there; a sentence naming one as the reason
   * for the other would be a claim the events do not make.
   */
  it("never call a change the cause of anything, in either language", () => {
    // Two patterns, because `\b` in JavaScript is an ASCII word boundary: no
    // boundary exists before "п", so a single alternation with `\b` in front
    // of it matched no Russian word at all and the half of this guard that
    // reads the Russian catalogue was never once exercised.
    const claims = [
      /\b(cause[ds]?|because|led to|due to|resulted|triggered)/i,
      /(привел|вызвал|из-за|причин)/i,
    ];
    for (const catalogue of [en.changes, ru.changes]) {
      for (const [key, value] of Object.entries(catalogue)) {
        if (key === "changeCause") continue;
        const said = `${key}: ${JSON.stringify(value)}`;
        for (const claim of claims) expect(said).not.toMatch(claim);
      }
      // The Russian half really does match something when something is there.
      expect(`x: причина`).toMatch(claims[1]);
    }
  });
});
