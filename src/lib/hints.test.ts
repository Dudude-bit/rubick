import { describe, expect, it } from "vitest";

import type { ContainerInfo, EventInfo, PodInfo } from "@/generated/types";
import { en } from "@/i18n/catalogue";
import { ru } from "@/i18n/ru";
import {
  addressIn,
  agentReport,
  hintFor,
  searchQuery,
  searchUrl,
  troubleOf,
  type Chain,
} from "./hints";

function container(
  name: string,
  over: Partial<ContainerInfo> = {}
): ContainerInfo {
  return {
    name,
    image: `registry.example.com/shop/${name}:2.14.1`,
    ready: true,
    started: true,
    phase: "app",
    state: { type: "running" },
    lastTerminated: null,
    restartCount: 0,
    ports: [],
    env: [],
    envFrom: [],
    ...over,
  };
}

function pod(over: Partial<PodInfo> = {}): PodInfo {
  return {
    name: "payments-7b6d9c5f4-x8k2p",
    namespace: "shop",
    uid: "u",
    status: {
      phase: "Running",
      display: "Running",
      ready: true,
      conditions: [],
      message: null,
      reason: null,
    },
    nodeName: "ip-10-0-31-8",
    podIp: "10.42.0.5",
    hostIp: null,
    containers: [container("app")],
    initContainers: [],
    labels: {},
    annotations: {},
    createdAt: null,
    restartCount: 0,
    lastRestartAt: null,
    cpuRequests: null,
    cpuLimits: null,
    memoryRequests: null,
    memoryLimits: "512Mi",
    ownerReferences: [],
    volumes: [
      {
        name: "config",
        source: "configMap",
        refs: [{ kind: "ConfigMap", name: "payments-config" }],
        mounts: [
          {
            container: "app",
            path: "/etc/payments",
            readOnly: true,
            subPath: null,
          },
        ],
      },
      {
        name: "creds",
        source: "secret",
        refs: [{ kind: "Secret", name: "payments-db-credentials" }],
        mounts: [
          {
            container: "app",
            path: "/etc/creds",
            readOnly: true,
            subPath: null,
          },
        ],
      },
    ],
    serviceAccountName: null,
    ...over,
  } as PodInfo;
}

let n = 0;
function event(reason: string, message: string, count = 1): EventInfo {
  n += 1;
  return {
    name: `e${n}`,
    namespace: "shop",
    uid: `e${n}`,
    type: "Warning",
    reason,
    message,
    source: null,
    involvedObject: {
      kind: "Pod",
      name: "payments",
      namespace: "shop",
      uid: null,
    },
    count,
    firstTimestamp: "2026-09-08T10:00:00Z",
    lastTimestamp: `2026-09-08T10:${String(n).padStart(2, "0")}:00Z`,
  };
}

const crashing = () =>
  pod({
    status: {
      phase: "Running",
      display: "CrashLoopBackOff",
      ready: false,
      conditions: [],
      message: null,
      reason: null,
    },
    containers: [
      container("app", {
        ready: false,
        state: { type: "waiting", reason: "CrashLoopBackOff" },
        lastTerminated: {
          exitCode: 1,
          signal: null,
          reason: "Error",
          message: null,
          startedAt: null,
          finishedAt: "2026-09-08T10:38:51Z",
        },
        restartCount: 14,
      }),
    ],
  });

const NONE: Chain = {
  address: null,
  service: null,
  sidecar: null,
  notRead: [],
};

describe("troubleOf", () => {
  it("names a crash loop before anything else the pod also has", () => {
    const trouble = troubleOf(crashing(), [
      event("Unhealthy", "Readiness probe failed"),
    ]);
    expect(trouble).toMatchObject({
      reason: "crashLoop",
      container: "app",
      restarts: 14,
    });
  });

  it("reads OOMKilled off the last termination", () => {
    const trouble = troubleOf(
      pod({
        containers: [
          container("app", {
            lastTerminated: {
              exitCode: 137,
              signal: 9,
              reason: "OOMKilled",
              message: null,
              startedAt: null,
              finishedAt: null,
            },
            restartCount: 3,
          }),
        ],
      }),
      []
    );
    expect(trouble).toMatchObject({
      reason: "oomKilled",
      limit: "512Mi",
      restarts: 3,
    });
  });

  it("reads a pull failure with the kubelet's own message", () => {
    const trouble = troubleOf(
      pod({
        containers: [
          container("app", {
            state: { type: "waiting", reason: "ImagePullBackOff" },
          }),
        ],
      }),
      [event("Failed", 'Failed to pull image "x:1": not found')]
    );
    expect(trouble).toMatchObject({
      reason: "imagePull",
      message: 'Failed to pull image "x:1": not found',
    });
  });

  it("reads a pending pod off FailedScheduling and says whether the answer changed", () => {
    const same = troubleOf(
      pod({
        status: {
          phase: "Pending",
          display: "Pending",
          ready: false,
          conditions: [],
          message: null,
          reason: null,
        },
      }),
      [event("FailedScheduling", "0/5 nodes are available", 4)]
    );
    expect(same).toMatchObject({
      reason: "pending",
      count: 4,
      sameEachTime: true,
    });
    const varied = troubleOf(
      pod({
        status: {
          phase: "Pending",
          display: "Pending",
          ready: false,
          conditions: [],
          message: null,
          reason: null,
        },
      }),
      [
        event("FailedScheduling", "0/5 nodes are available"),
        event("FailedScheduling", "0/6 nodes are available"),
      ]
    );
    expect(varied).toMatchObject({ reason: "pending", sameEachTime: false });
  });

  it("finds nothing wrong with a ready pod that has old warnings", () => {
    expect(
      troubleOf(pod(), [event("Unhealthy", "Readiness probe failed")])
    ).toBeNull();
  });
});

describe("addressIn", () => {
  it("classifies the last failed address: sidecar, in cluster, outside", () => {
    expect(
      addressIn(["dial tcp 127.0.0.1:5432: connect: connection refused"])
    ).toMatchObject({
      host: "127.0.0.1",
      port: 5432,
      where: "sidecar",
      refused: true,
    });
    expect(
      addressIn(["dial tcp 10.43.39.231:5432: connect: connection refused"])
    ).toMatchObject({
      where: "inCluster",
      refused: true,
    });
    expect(
      addressIn(["connect to shop-db-rw.shop.svc:5432 failed: timeout"])
    ).toMatchObject({
      where: "inCluster",
      timedOut: true,
    });
    expect(
      addressIn([
        "starting",
        "server selection timeout: cluster0-shard-00-01.ab12c.mongodb.net:27017 i/o timeout",
      ])
    ).toMatchObject({
      host: "cluster0-shard-00-01.ab12c.mongodb.net",
      where: "outside",
      timedOut: true,
    });
  });

  it("returns nothing for lines that name no failed address", () => {
    expect(addressIn(["listening on :8080", "GET / 200"])).toBeNull();
  });
});

describe("hintFor", () => {
  it("blames nothing but the chain it read: an empty Service behind a refused address", () => {
    const chain: Chain = {
      address: addressIn([
        "dial tcp 10.43.39.231:5432: connect: connection refused",
      ]),
      service: { name: "shop-db-rw", namespace: "shop", ready: 0, total: 3 },
      sidecar: null,
      notRead: [],
    };
    const hint = hintFor(troubleOf(crashing(), [])!, crashing(), chain);
    expect(hint.headline.key).toBe("guessCrashRefusedServiceEmpty");
    expect(hint.checks.map((c) => c.says.key)).toEqual([
      "checkService",
      "checkLastLines",
      "checkConfig",
      "checkConfig",
    ]);
    expect(hint.checks[0].to).toEqual({
      kind: "object",
      objectKind: "Service",
      name: "shop-db-rw",
      namespace: "shop",
    });
  });

  it("points at the sidecar when the address is this pod itself", () => {
    const sidecar = container("cloud-sql-proxy", {
      ready: false,
      restartCount: 6,
    });
    const chain: Chain = {
      address: addressIn([
        "dial tcp 127.0.0.1:5432: connect: connection refused",
      ]),
      service: null,
      sidecar,
      notRead: [],
    };
    const hint = hintFor(troubleOf(crashing(), [])!, crashing(), chain);
    expect(hint.headline).toEqual({
      key: "guessCrashRefusedSidecar",
      values: {
        host: "127.0.0.1",
        port: 5432,
        sidecar: "cloud-sql-proxy",
        state: "running, not ready",
      },
    });
  });

  it("says a timeout outside the cluster is the road, and lists the policies it cannot read", () => {
    const chain: Chain = {
      address: addressIn(["cluster0.ab12c.mongodb.net:27017 i/o timeout"]),
      service: null,
      sidecar: null,
      notRead: ["NetworkPolicies: this app has no reader for them yet"],
    };
    const hint = hintFor(troubleOf(crashing(), [])!, crashing(), chain);
    expect(hint.headline.key).toBe("guessCrashTimeoutOutside");
  });

  it("falls back to the plain crash sentence when the log named no address", () => {
    const hint = hintFor(troubleOf(crashing(), [])!, crashing(), NONE);
    expect(hint.headline.key).toBe("guessCrashLoop");
    expect(hint.lines[0]).toEqual({
      key: "factExited",
      values: { container: "app", code: 1, n: 14 },
    });
  });
});

describe("the words", () => {
  /**
   * The chain is read, never tested. A guess that reads as a verdict is
   * the lie this feature exists to avoid, so every sentence past the
   * reading carries the hedge, in both languages.
   */
  it("hedge every guess with probably or usually, in both languages", () => {
    const hedges = {
      en: /\b(probably|usually)\b/i,
      ru: /(скорее всего|обычно)/i,
    } as const;
    for (const [lang, catalogue] of [
      ["en", en.hints],
      ["ru", ru.hints],
    ] as const) {
      const guesses = Object.entries(catalogue).filter(([key]) =>
        key.startsWith("guess")
      );
      expect(guesses.length).toBeGreaterThan(5);
      for (const [key, text] of guesses) {
        expect(`${lang} ${key}: ${text}`).toMatch(hedges[lang]);
      }
    }
  });
});

describe("searchQuery", () => {
  it("strips the pod, namespace, image, node and host names before the query leaves", () => {
    const address = addressIn([
      "dial tcp 10.43.39.231:5432: connect: connection refused",
    ]);
    const query = searchQuery(
      troubleOf(crashing(), [])!,
      crashing(),
      address,
      true
    );
    expect(query).not.toContain("payments");
    expect(query).not.toContain("shop");
    expect(query).not.toContain("10.43.39.231");
    expect(query).toContain("CrashLoopBackOff");
    expect(query).toContain("connection refused");
    expect(
      searchQuery(troubleOf(crashing(), [])!, crashing(), address, false)
    ).toContain("10.43.39.231");
  });

  it("builds the engine's address with the utm source on every engine", () => {
    expect(searchUrl("google", "", "a b")).toBe(
      "https://www.google.com/search?q=a%20b&utm_source=rubick.tech"
    );
    expect(searchUrl("duckduckgo", "", "a")).toContain(
      "duckduckgo.com/?q=a&utm_source=rubick.tech"
    );
    expect(searchUrl("custom", "https://s.example/?q={q}", "a")).toBe(
      "https://s.example/?q=a"
    );
  });
});

describe("agentReport", () => {
  /**
   * Nothing here accepts a Secret's value, so none can be pasted into a
   * chat by accident. The test hands over an object that carries values
   * anyway and reads the report for them.
   */
  it("never carries a Secret value, and always says what was not read", () => {
    const leaky = {
      kind: "Secret",
      name: "payments-db-credentials",
      path: "/etc/creds",
      keys: 2,
      values: { password: "hunter2" },
    };
    const report = agentReport({
      version: "4.9.2",
      context: "prod-eu-1",
      at: "2026-09-08T10:39:02Z",
      pod: crashing(),
      trouble: troubleOf(crashing(), [])!,
      logLines: [
        "ERROR db: dial tcp 10.43.39.231:5432: connect: connection refused",
      ],
      logContainer: "app",
      logPrevious: true,
      events: [event("BackOff", "Back-off restarting failed container", 9)],
      chain: {
        address: addressIn([
          "dial tcp 10.43.39.231:5432: connect: connection refused",
        ]),
        service: { name: "shop-db-rw", namespace: "shop", ready: 0, total: 3 },
        sidecar: null,
        notRead: ["NetworkPolicy in shop (403)"],
      },
      mounts: [leaky],
      guess: "database unreachable",
    });
    expect(report).not.toContain("hunter2");
    expect(report).toContain(
      "Secret payments-db-credentials mounted at /etc/creds (2 keys, values not included)"
    );
    expect(report).toContain("Not read: NetworkPolicy in shop (403)");
    expect(report).toContain("App's own guess: database unreachable");
    expect(report).toContain("Service shop/shop-db-rw: 0 of 3 endpoints ready");
    expect(report).toContain("BackOff x9");
    expect(report.startsWith("# Rubick 4.9.2 · context prod-eu-1")).toBe(true);
  });
});
