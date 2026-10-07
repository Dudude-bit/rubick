import { describe, expect, it } from "vite-plus/test";

import type { DeploymentContainerInfo, ProbeInfo } from "@/generated/types";
import { en } from "@/i18n/catalogue";
import { ru } from "@/i18n/ru";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import {
  COMPARED_FIELDS,
  diffRevisions,
  diffSnapshots,
  gapsOf,
  gapWords,
  helmReleaseOf,
  spansCovering,
  otherDifferences,
  timelineOf,
  type JournalEntry,
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
    probes: { readiness: null, liveness: null, startup: null },
    command: [],
    args: [],
    env: [],
    envFrom: [],
    ...over,
  };
}

function probe(path: string, period = 10): ProbeInfo {
  return {
    handler: {
      type: "httpGet",
      path,
      port: "http",
      scheme: "HTTP",
      host: null,
    },
    initialDelaySeconds: 0,
    periodSeconds: period,
    timeoutSeconds: 1,
    successThreshold: 1,
    failureThreshold: 3,
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
    template: null,
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

describe("what two revisions are compared on", () => {
  // Every field differs, compared or not: one both sides hold equal could
  // start being read without the test below noticing.
  const everything = (n: number) =>
    revision(
      n,
      [
        container("app", `app:${n}`, {
          phase: n % 2 === 0 ? "sidecar" : "app",
          ports: [8000 + n],
          env: [{ name: "MODE", value: `m${n}`, valueFrom: null }],
          envFrom: [
            {
              prefix: `P${n}_`,
              configMapRef: `cfg-${n}`,
              secretRef: `sec-${n}`,
              optional: n % 2 === 0,
            },
          ],
          resources: {
            requests: { cpu: `${n}00m` },
            limits: { memory: `${n}Gi` },
          },
          command: [`/bin/app-${n}`],
          args: [`--n=${n}`],
          probes: {
            readiness: probe(`/ready-${n}`, n),
            liveness: probe(`/live-${n}`, n),
            startup: probe(`/start-${n}`, n),
          },
        }),
      ],
      {
        current: n % 2 === 0,
        changeCause: `rollout ${n}`,
        templateAnnotations: { "checksum/config": `c${n}` },
      }
    );

  /**
   * The "nothing changed in what is compared" line is only true while the
   * list it spells out is the list the diff reads. A field the diff starts
   * reading without joining `COMPARED_FIELDS` goes unmentioned there, and one
   * the diff stops reading is still promised to the reader.
   */
  it("reports a change under every compared field, and under no other", () => {
    const roots = diffRevisions(everything(1), everything(2)).map(
      (change) => change.field.split(".")[0]
    );
    expect(new Set(roots)).toEqual(new Set(COMPARED_FIELDS));
  });

  /**
   * The sentence is written out by hand in each catalogue. The checksum
   * annotations are described in the reader's language rather than named,
   * so only the container's own field names are held to it.
   */
  it("names each compared container field in the unchanged-template line, in both languages", () => {
    const named = COMPARED_FIELDS.filter((field) => field !== "annotations");
    for (const line of [
      en.changes.comparedUnchangedRestUnread,
      ru.changes.comparedUnchangedRestUnread,
    ]) {
      // By word, not by the catalogue's punctuation, which is a translator's.
      const said = line.match(/[A-Za-z]+/g) ?? [];
      for (const field of named) expect(said).toContain(field);
    }
  });
});

describe("a revision that changed only what the named fields do not cover", () => {
  const template = (path: string, command: string[]) => ({
    metadata: { labels: { app: "search" } },
    spec: {
      containers: [
        {
          name: "app",
          image: "nginx:1.27-alpine",
          command,
          readinessProbe: { httpGet: { path, port: "http" } },
        },
      ],
      volumes: [],
    },
  });
  const search = (n: number, path: string, command: string[]) =>
    revision(
      n,
      [
        container("app", "nginx:1.27-alpine", {
          probes: { readiness: probe(path), liveness: null, startup: null },
        }),
      ],
      {
        template: template(path, command),
      }
    );

  /**
   * Dana's `search`: revision 2 changed only `readinessProbe.httpGet.path`,
   * and the comparison said nothing changed in what it compared.
   */
  it("names a readiness probe's path change", () => {
    expect(
      diffRevisions(search(1, "/", []), search(2, "/healthz", []))
    ).toEqual([
      {
        container: "app",
        field: "readinessProbe.httpGet.path",
        from: "/",
        to: "/healthz",
      },
    ]);
  });

  /** A field the named comparison does not read is still a difference, said as one. */
  it("reports every other differing field rather than calling the templates the same", () => {
    const items = timelineOf({
      revisions: [
        search(1, "/", ["nginx"]),
        search(2, "/", ["nginx", "-g", "daemon off;"]),
      ],
      deliveries: [],
      helm: [],
      journal: [],
      spans: [],
      window: { from: T0, to: T0 + 10 * HOUR },
    });
    const newest = items.find(
      (item) => item.kind === "revision" && item.revision.number === 2
    );
    expect(newest?.kind === "revision" && newest.against).toEqual({
      state: "compared",
      missing: 0,
      changes: [],
      others: [
        {
          container: null,
          field: "spec.containers[app].command",
          from: '["nginx"]',
          to: '["nginx","-g","daemon off;"]',
        },
      ],
    });
  });

  /** What the named comparison reported is not said a second time among the others. */
  it("leaves out of the others what the named fields already reported", () => {
    expect(
      otherDifferences(
        search(1, "/", []),
        search(2, "/healthz", []),
        diffRevisions(search(1, "/", []), search(2, "/healthz", []))
      )
    ).toEqual([]);
  });

  /** Without the whole templates, an empty named diff is not a claim that nothing changed. */
  it("says it could not compare the rest when a whole template is missing", () => {
    expect(
      otherDifferences(revision(1, []), search(2, "/", []), [])
    ).toBeNull();
  });
});

describe("a timeline that starts where its object does", () => {
  const NOW = T0 + 7 * 24 * HOUR;
  const week = { from: NOW - 7 * 24 * HOUR, to: NOW };
  const born = new Date(NOW - 16 * 60_000).toISOString();
  const timeline = (createdAt: string | null, journal: JournalEntry[] = []) =>
    timelineOf({
      revisions: [],
      deliveries: [],
      helm: [],
      journal,
      spans: [],
      window: week,
      createdAt,
    });

  /**
   * A StatefulSet 16 minutes old showed a dashed "Not observed" gap starting
   * a week earlier: the honest gap marker turned to noise over a stretch
   * when there was nothing to observe.
   */
  it("draws no gap before the object existed, and marks where it began", () => {
    const items = timeline(born);
    expect(items).toEqual([
      { kind: "gap", at: NOW, gap: { from: Date.parse(born), to: NOW } },
      { kind: "created", at: Date.parse(born) },
    ]);
  });

  /** Without a creation time the app cannot say the object is young, so the whole window stays a gap. */
  it("keeps the whole window when the creation time is not known", () => {
    expect(timeline(null)).toEqual([
      { kind: "gap", at: NOW, gap: { from: week.from, to: NOW } },
    ]);
  });

  /** A creation the journal watched happen is already on the timeline in its own words. */
  it("does not mark the creation twice when the journal saw it", () => {
    const seen: JournalEntry = {
      id: "c",
      context: "dev",
      kind: "StatefulSet",
      namespace: "shop",
      name: "orders-db",
      at: Date.parse(born) + 1000,
      field: "created",
      key: null,
      from: null,
      to: null,
    };
    expect(timeline(born, [seen]).some((item) => item.kind === "created")).toBe(
      false
    );
  });

  /** An object older than the window keeps the window's own start. */
  it("leaves the window alone for an object older than it", () => {
    const old = new Date(week.from - HOUR).toISOString();
    expect(timeline(old)).toEqual([
      { kind: "gap", at: NOW, gap: { from: week.from, to: NOW } },
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

  /**
   * Every scope switch away and back left "Не наблюдали 17 секунд": true of
   * this object, read as the app being down. Fails if a stretch some other
   * span covered is not told apart from one nobody watched.
   */
  it("marks a stretch the app spent watching other namespaces as the scope being elsewhere", () => {
    const mine = span(T0, T0 + HOUR);
    const other = span(T0 + HOUR, T0 + 2 * HOUR);
    expect(gapsOf([mine], T0, T0 + 2 * HOUR, [mine, other])).toEqual([
      { from: T0 + HOUR, to: T0 + 2 * HOUR, elsewhere: true },
    ]);
  });

  /** Deleting the check for a dark hole makes a closed laptop read as a scope switch. */
  it("keeps a stretch no span covered, or only partly covered, as not observed", () => {
    const mine = span(T0, T0 + HOUR);
    const other = span(T0 + HOUR, T0 + 2 * HOUR);
    expect(gapsOf([mine], T0, T0 + 3 * HOUR, [mine])).toEqual([
      { from: T0 + HOUR, to: T0 + 3 * HOUR },
    ]);
    expect(gapsOf([mine], T0, T0 + 3 * HOUR, [mine, other])).toEqual([
      { from: T0 + HOUR, to: T0 + 3 * HOUR },
    ]);
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
      others: null,
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

describe("which spans watched an object", () => {
  const span = (scope?: string[], unwatched?: string[]): ObservedSpan => ({
    from: T0,
    seenAt: T0,
    to: T0 + HOUR,
    ...(scope && { scope }),
    ...(unwatched && { unwatched }),
  });

  /**
   * Hours spent scoped to kube-system were drawn as hours watched on a
   * Deployment in lena-sandbox.
   */
  it("counts a span only for the namespaces it watched", () => {
    const kubeSystem = span(["kube-system"]);
    const both = span(["kube-system", "shop"]);
    const everywhere = span();
    expect(
      spansCovering([kubeSystem, both, everywhere], {
        kinds: [],
        namespaces: ["shop"],
      })
    ).toEqual([both, everywhere]);
    expect(
      spansCovering([kubeSystem, both, everywhere], {
        kinds: [],
        namespaces: [],
      })
    ).toEqual([everywhere]);
  });

  it("does not count a span for a kind it was refused", () => {
    expect(
      spansCovering([span(undefined, ["DaemonSet"])], {
        kinds: ["DaemonSet"],
        namespaces: ["shop"],
      })
    ).toEqual([]);
  });
});

describe("a gap in words", () => {
  const t: T = (section, key, values) => translate("en", section, key, values);
  const r: T = (section, key, values) => translate("ru", section, key, values);
  const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);

  /** A resubscribe of a few seconds read "Не наблюдали с 20:23 по 20:23". */
  it("gives a gap under a minute its length, not two equal minutes", () => {
    const gap = { from: T0, to: T0 + 4_000 };
    expect(gapWords(gap, t, clock)).toBe("Not observed for 4 seconds at 00:00");
    expect(gapWords(gap, r, clock)).toBe("Не наблюдали 4 секунды в 00:00");
  });

  it("gives a longer gap its two ends", () => {
    expect(gapWords({ from: T0, to: T0 + HOUR }, t, clock)).toBe(
      "Not observed 00:00 to 01:00"
    );
  });

  /** A pill click is not the app going dark; fails if the scope's absence is worded as not observing. */
  it("says the namespaces were outside the scope when the app was watching elsewhere", () => {
    const gap = { from: T0, to: T0 + 17_000, elsewhere: true };
    expect(gapWords(gap, t, clock)).toBe(
      "Watching other namespaces, not this one, for 17 seconds at 00:00"
    );
    expect(gapWords(gap, r, clock)).toBe(
      "В течение 17 секунд (00:00) следили за другими пространствами имён, а за этим нет"
    );
    expect(
      gapWords({ from: T0, to: T0 + HOUR, elsewhere: true }, r, clock)
    ).toBe(
      "С 00:00 по 01:00 следили за другими пространствами имён, а за этим нет"
    );
  });

  /**
   * Lena read "Вне наблюдаемых пространств имён 57 секунд в 7 окт., 09:32" and
   * could not tell what the app had done for those 57 seconds. Fails if the
   * row stops saying it was watching elsewhere, or loses the number's form.
   */
  it.each([
    [1, "В течение 1 секунды (00:00) следили"],
    [2, "В течение 2 секунд (00:00) следили"],
    [21, "В течение 21 секунды (00:00) следили"],
    [57, "В течение 57 секунд (00:00) следили"],
  ])(
    "words a %i s stretch spent in another namespace in the form its number takes",
    (seconds, start) => {
      const span = (from: number, to: number | null): ObservedSpan => ({
        from,
        to,
        seenAt: to ?? from,
      });
      const [hole] = gapsOf(
        [span(T0 - HOUR, T0), span(T0 + seconds * 1000, T0 + HOUR)],
        T0 - HOUR,
        T0 + HOUR,
        [span(T0 - HOUR, T0 + HOUR)]
      );
      expect(hole.elsewhere).toBe(true);
      expect(gapWords(hole, r, clock)).toMatch(
        new RegExp(`^${start.replace(/[()]/g, "\\$&")}`)
      );
      expect(gapWords(hole, r, clock)).not.toMatch(/Вне наблюдаемых/);
    }
  );
});
