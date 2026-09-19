import { describe, expect, it } from "vitest";

import type { ContainerInfo, EventInfo, PodInfo } from "@/generated/types";
import { en } from "@/i18n/catalogue";
import { ru } from "@/i18n/ru";
import {
  addressIn,
  agentReport,
  hintFor,
  namespaceOf,
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
  servicesKnown: true,
  endpointsKnown: true,
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
      servicesKnown: true,
      endpointsKnown: true,
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
      servicesKnown: true,
      endpointsKnown: true,
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
        // Its own sentence: "running, not ready" composed in English and
        // dropped into a Russian one is the app writing half a language.
        state: { key: "stateRunningNotReady" },
      },
    });
  });

  it("says a timeout outside the cluster is the road, and lists the policies it cannot read", () => {
    const chain: Chain = {
      address: addressIn(["cluster0.ab12c.mongodb.net:27017 i/o timeout"]),
      service: null,
      servicesKnown: true,
      endpointsKnown: true,
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
      values: {
        container: "app",
        code: 1,
        // Its own sentence: no language can hand another a substring of
        // its own plural, so the count is chosen before the line holding it.
        restarts: { key: "countRestarts", values: { n: 14 } },
      },
    });
  });

  /**
   * English said "1 restarts" and Russian got one form for every number.
   * The counted noun is a plural object now, and the sentence holds the
   * rendered form rather than the number.
   */
  it("counts restarts in a form each language actually has", () => {
    const restarts = en.hints.countRestarts as { one: string; other: string };
    expect(restarts.one).toContain("restart");
    expect(restarts.one).not.toContain("restarts");
    expect(Object.keys(ru.hints.countRestarts as object).sort()).toEqual([
      "few",
      "many",
      "one",
      "other",
    ]);
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

describe("what the failure line actually names", () => {
  /**
   * `main.py:42` matches the host:port shape exactly, and the last match
   * on the line won — so a stack-trace frame became the address the whole
   * chain was read from, and the panel classified a source file.
   */
  it("does not read a stack-trace frame as an address", () => {
    const address = addressIn([
      'File "/app/handlers/main.py:42", in connect: connection refused to db:5432',
    ]);
    expect(address?.host).toBe("db");
    expect(addressIn(["connection refused at worker.go:118"])).toBeNull();
  });

  /**
   * `no route to host` says the connection failed and says neither how.
   * Reported as a refusal it claimed something answered and said no, and
   * then told the reader a firewall would have timed out instead.
   */
  it("does not call an unreachable host a refusal", () => {
    const address = addressIn([
      "dial tcp 203.0.113.10:443: connect: no route to host",
    ]);
    expect(address?.refused).toBe(false);
    expect(address?.timedOut).toBe(false);
    expect(address?.unclassified).toBe(true);
    expect(
      hintFor(troubleOf(crashing(), [])!, crashing(), {
        ...NONE,
        address,
      }).headline.key
    ).toBe("guessCrashUnreachableOutside");
  });

  /**
   * `shop-db-rw.billing.svc.cluster.local` was matched on the bare name
   * against the pod's own namespace, so a same-named Service next door was
   * reported — with its endpoint count — as what stands behind an address
   * in a namespace nothing listed.
   */
  it("reads the namespace out of a cluster-DNS name, and never out of an IP", () => {
    expect(namespaceOf("shop-db-rw.billing.svc.cluster.local", "shop")).toEqual(
      {
        name: "shop-db-rw",
        namespace: "billing",
        qualified: true,
      }
    );
    expect(namespaceOf("shop-db-rw.svc.cluster.local", "shop").namespace).toBe(
      "shop"
    );
    expect(namespaceOf("shop-db-rw", "shop")).toEqual({
      name: "shop-db-rw",
      namespace: "shop",
      qualified: false,
    });
    // `10.43.39.231` read as name=10, namespace=43 matched nothing at all.
    expect(namespaceOf("10.43.39.231", "shop")).toEqual({
      name: "10.43.39.231",
      namespace: "shop",
      qualified: false,
    });
  });

  /**
   * `db.shop` is the cross-namespace form every Kubernetes reader writes.
   * Two labels and no `.svc` was called outside the cluster, which gated
   * off the Service lookup and added a NetworkPolicy line about a hop that
   * never leaves it.
   */
  it("knows the cross-namespace form when it knows the namespace", () => {
    const line = ["dial tcp db.shop:5432: connect: connection refused"];
    expect(addressIn(line)?.where).toBe("outside");
    expect(addressIn(line, ["shop"])?.where).toBe("inCluster");
  });
});

describe("trouble that is over, and trouble in the wrong order", () => {
  /**
   * A container killed for memory under `restartPolicy: Always` spends
   * nearly all its time in CrashLoopBackOff, so the OOM arm sitting after
   * the crash-loop arm was unreachable for exactly the pods it was written
   * for — while the Containers tab on the same page said OOMKilled.
   */
  it("names the OOM kill behind a crash loop, the way the Containers tab does", () => {
    const pod = crashing();
    const oomed = {
      ...pod,
      containers: pod.containers.map((c) => ({
        ...c,
        lastTerminated: {
          exitCode: 137,
          signal: 9,
          reason: "OOMKilled",
          message: null,
          startedAt: null,
          finishedAt: new Date().toISOString(),
        },
      })),
    };
    expect(troubleOf(oomed, [])?.reason).toBe("oomKilled");
  });

  /**
   * One OOM kill days ago, ready ever since. Left alone it put a permanent
   * "is killed for using more memory" panel on a healthy pod.
   */
  it("says nothing about a kill the pod has been ready since", () => {
    const pod = crashing();
    const settled = {
      ...pod,
      status: { ...pod.status, ready: true, phase: "Running" },
      containers: pod.containers.map((c) => ({
        ...c,
        state: { type: "running" as const },
        restartCount: 1,
        lastTerminated: {
          exitCode: 137,
          signal: 9,
          reason: "OOMKilled",
          message: null,
          startedAt: null,
          finishedAt: new Date(Date.now() - 4 * 60 * 60_000).toISOString(),
        },
      })),
    };
    expect(troubleOf(settled, [])).toBeNull();
  });

  /**
   * An hour-old FailedMount on a pod that has been Running since. Every
   * other arm gates on the pod's state; this one consulted only the event,
   * and drew a trouble panel in the present tense over a healthy pod.
   */
  it("says nothing about a mount that failed before the pod came up", () => {
    const pod = crashing();
    const running = {
      ...pod,
      status: { ...pod.status, ready: true, phase: "Running" },
      containers: pod.containers.map((c) => ({
        ...c,
        state: { type: "running" as const },
        lastTerminated: null,
        restartCount: 0,
      })),
    };
    expect(
      troubleOf(running, [
        event("FailedMount", "MountVolume.SetUp failed for volume creds", 3),
      ])
    ).toBeNull();
  });
});

describe("the Service leg, when the app could not read it", () => {
  const refusedAddress = () =>
    addressIn(["dial tcp 10.43.39.231:5432: connect: connection refused"]);

  /**
   * "No Service in this namespace answers to it" is a claim about the
   * cluster. A 403 on the Services of that namespace is a fact about this
   * app, and it produced the same sentence — sending a reader to hunt for
   * a wrong address in a cluster where the address was fine.
   */
  it("does not call a Services list it could not read a cluster with no such Service", () => {
    const unread = hintFor(troubleOf(crashing(), [])!, crashing(), {
      ...NONE,
      address: refusedAddress(),
      servicesKnown: false,
    });
    const empty = hintFor(troubleOf(crashing(), [])!, crashing(), {
      ...NONE,
      address: refusedAddress(),
      servicesKnown: true,
    });
    expect(unread.headline.key).toBe("guessCrashInClusterUnread");
    expect(empty.headline.key).toBe("guessCrashInClusterUnknown");
  });

  /**
   * The Service was found and its endpoints were not. Reported as zero
   * ready, the panel says the pod itself is probably fine over a count
   * nobody took.
   */
  it("does not report an uncounted Service as one with nothing behind it", () => {
    const hint = hintFor(troubleOf(crashing(), [])!, crashing(), {
      ...NONE,
      address: refusedAddress(),
      endpointsKnown: false,
      service: {
        name: "shop-db-rw",
        namespace: "shop",
        ready: null,
        total: null,
      },
    });
    expect(hint.headline.key).toBe("guessCrashServiceUncounted");
  });

  /**
   * A timeout and a refusal send a reader to different places: one is a
   * process saying no, the other is packets never arriving. Both Service
   * sentences said "refused the connection" whatever the line said.
   */
  it("says what the line said, not always that the connection was refused", () => {
    const timedOut = addressIn(["dial tcp 10.43.39.231:5432: i/o timeout"]);
    const service = {
      name: "shop-db-rw",
      namespace: "shop",
      ready: 3,
      total: 3,
    };
    expect(
      hintFor(troubleOf(crashing(), [])!, crashing(), {
        ...NONE,
        address: timedOut,
        service,
      }).headline.key
    ).toBe("guessCrashTimeoutServiceReady");
    expect(
      hintFor(troubleOf(crashing(), [])!, crashing(), {
        ...NONE,
        address: refusedAddress(),
        service,
      }).headline.key
    ).toBe("guessCrashRefusedServiceReady");
  });

  /**
   * `whereIs` calls 127.0.0.1 "sidecar", and with no container claiming
   * the port the arm fell through to the outside branches: a pod dialling
   * its own loopback was told something outside the cluster refused it.
   */
  it("never calls this pod's own loopback something outside the cluster", () => {
    const hint = hintFor(troubleOf(crashing(), [])!, crashing(), {
      ...NONE,
      address: addressIn([
        "dial tcp 127.0.0.1:15000: connect: connection refused",
      ]),
    });
    expect(hint.headline.key).toBe("guessCrashLoopback");
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
    // Not even with the switch off: the query carries what the app
    // recognised, never the line the container wrote.
    expect(
      searchQuery(troubleOf(crashing(), [])!, crashing(), address, false)
    ).not.toContain("10.43.39.231");
  });

  /**
   * The credential is in the same line as the address: a DSN, a JDBC URL,
   * a token a client echoed. Sending the raw line to a search engine put
   * the production database password into a Google query, with the switch
   * that claims to be the cautious one turned on.
   */
  it("sends what the app recognised in the failure, never the line itself", () => {
    const address = addressIn([
      'org.postgresql.util.PSQLException: Connection refused: url="jdbc:postgresql://db.shop.svc.cluster.local:5432/app?user=svc&password=Hunter2-prod" dial tcp 10.43.39.231:5432: connect: connection refused',
    ]);
    for (const strip of [true, false]) {
      const query = searchQuery(
        troubleOf(crashing(), [])!,
        crashing(),
        address,
        strip
      );
      expect(query).not.toContain("Hunter2-prod");
      expect(query).not.toContain("password=");
      expect(query).not.toContain("PSQLException");
      expect(query).toContain("connection refused");
    }
  });

  /**
   * Replacing the shorter name first left the longer one unmatched: with
   * namespace `shop` gone from `db.shop.svc.cluster.local`, neither the
   * host rule nor the `.svc` rule could see what was left.
   */
  it("takes the longest name out first, so a shorter one cannot shield it", () => {
    // `shop` replaced before `db.shop.svc.cluster.local` left `db.….svc…`,
    // which neither the host rule nor the `.svc` rule could then match.
    const query = searchQuery(
      {
        reason: "failedMount",
        volume: "creds",
        message:
          "MountVolume.SetUp failed for volume creds: secret not found at db.shop.svc.cluster.local",
        count: 1,
      },
      crashing(),
      null,
      true
    );
    expect(query).not.toContain("svc.cluster.local");
    expect(query).not.toContain("shop");
  });

  /** A cut through a surrogate pair made `encodeURIComponent` throw, and
   * the button then did nothing at all. */
  it("cuts the query by code point, so the address can always be built", () => {
    const long = "🙂".repeat(400);
    const query = searchQuery(
      { reason: "failedMount", volume: null, message: long, count: 1 },
      crashing(),
      null,
      false
    );
    expect(() => searchUrl("google", "", query)).not.toThrow();
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
   * No Secret is read, so a mount is a name and a key count. The log lines
   * are a different matter — they are whatever the container printed, and
   * a framework that echoes its resolved configuration prints a password.
   * The report said "secrets never" over both.
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
        "INFO  spring.datasource.url=jdbc:postgresql://db:5432/app?password=Hunter2-prod",
        "INFO  Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      ],
      logContainer: "app",
      logPrevious: true,
      events: [event("BackOff", "Back-off restarting failed container", 9)],
      chain: {
        address: addressIn([
          "dial tcp 10.43.39.231:5432: connect: connection refused",
        ]),
        servicesKnown: true,
        endpointsKnown: true,
        service: { name: "shop-db-rw", namespace: "shop", ready: 0, total: 3 },
        sidecar: null,
        notRead: ["NetworkPolicy in shop (403)"],
      },
      mounts: [leaky],
      guess: "database unreachable",
    });
    expect(report).not.toContain("hunter2");
    // What the container printed, not what the app read.
    expect(report).not.toContain("Hunter2-prod");
    expect(report).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    // And the line is still there, so the reader has not lost the trail.
    expect(report).toContain("spring.datasource.url=");
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
