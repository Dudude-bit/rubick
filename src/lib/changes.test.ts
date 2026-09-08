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

  it("ends a span the app never closed at the moment it was last seen alive", () => {
    const gaps = gapsOf([span(T0, null, T0 + 3 * HOUR)], T0, T0 + 5 * HOUR);
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
    expect(newest.kind === "revision" && newest.changes).toEqual([
      { container: "app", field: "image", from: "app:1", to: "app:2" },
    ]);
    const oldest = items[3];
    expect(oldest.kind === "revision" && oldest.changes).toBeNull();
  });
});

describe("diffSnapshots", () => {
  it("reports each watched field once, and nothing when they held still", () => {
    const before = {
      generation: 3,
      images: ["app:1", "proxy:1"],
      replicas: 2,
      hashes: new Map([["checksum/config", "a"]]),
    };
    expect(diffSnapshots(before, before)).toEqual([]);
    expect(
      diffSnapshots(before, {
        generation: 4,
        images: ["app:2", "proxy:1"],
        replicas: 3,
        hashes: new Map([["checksum/config", "b"]]),
      })
    ).toEqual([
      { field: "generation", key: null, from: "3", to: "4" },
      { field: "image", key: "0", from: "app:1", to: "app:2" },
      { field: "replicas", key: null, from: "2", to: "3" },
      { field: "annotation", key: "checksum/config", from: "a", to: "b" },
    ]);
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
    const claims =
      /\b(cause[ds]?|because|led to|due to|resulted|triggered|привел|вызвал|из-за|причин)/i;
    for (const catalogue of [en.changes, ru.changes]) {
      for (const [key, value] of Object.entries(catalogue)) {
        if (key === "changeCause") continue;
        expect(`${key}: ${value}`).not.toMatch(claims);
      }
    }
  });
});
