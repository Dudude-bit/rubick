import { describe, expect, it } from "vite-plus/test";

import type { ContainerInfo, EventInfo, PodInfo } from "@/generated/types";
import { en } from "@/i18n/catalogue";
import { ru } from "@/i18n/ru";
import {
  addressIn,
  agentReport,
  hintFor,
  namespaceOf,
  redact,
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
    resources: { requests: {}, limits: {} },
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
      exitUnreported: false,
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
  policies: { read: "unread", why: null },
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

  /** Sam's checkout pod lost its "Most likely" crash loop whenever the read
   *  caught it up between crashes. Fails if the running instant of a recent
   *  loop is not the same trouble as the waiting one. */
  it("names a crash loop caught while its container is up", () => {
    const exit = {
      exitCode: 1,
      signal: null,
      reason: "Error",
      message: null,
      startedAt: null,
      finishedAt: new Date(Date.now() - 30_000).toISOString(),
    };
    const up = pod({
      containers: [container("app", { lastTerminated: exit, restartCount: 6 })],
    });
    expect(troubleOf(up, [])).toBeNull();
    expect(
      troubleOf(
        {
          ...up,
          status: {
            ...up.status,
            loopingUntil: new Date(Date.now() + 60_000).toISOString(),
          },
        },
        []
      )
    ).toMatchObject({ reason: "crashLoop", container: "app", restarts: 6 });
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
            resources: { requests: {}, limits: { memory: "512Mi" } },
          }),
        ],
      }),
      []
    );
    expect(trouble).toMatchObject({
      reason: "oomKilled",
      limit: "512Mi",
      restarts: 3,
      saidOom: true,
    });
  });

  /**
   * The panel used to quote the pod's sum of limits: an Istio app with no
   * limit, killed beside a proxy's 1Gi, was told 1Gi. Fails if the limit
   * quoted is anything but the killed container's own.
   */
  it("quotes the killed container's own limit, never the pod's sum", () => {
    const oomKilled = (name: string, over: Partial<ContainerInfo> = {}) =>
      container(name, {
        state: { type: "waiting", reason: "CrashLoopBackOff" },
        lastTerminated: {
          exitCode: 137,
          signal: 9,
          reason: "OOMKilled",
          message: null,
          startedAt: null,
          finishedAt: null,
        },
        restartCount: 2,
        ...over,
      });
    const proxy = container("istio-proxy", {
      resources: { requests: {}, limits: { memory: "1Gi" } },
    });

    expect(
      troubleOf(
        pod({ containers: [oomKilled("app"), proxy], memoryLimits: "1Gi" }),
        []
      )
    ).toMatchObject({ reason: "oomKilled", container: "app", limit: null });
    expect(
      troubleOf(
        pod({
          containers: [proxy],
          initContainers: [
            oomKilled("migrate", {
              phase: "init",
              resources: { requests: {}, limits: { memory: "256Mi" } },
            }),
          ],
        }),
        []
      )
    ).toMatchObject({ container: "migrate", limit: "256Mi" });
  });

  /** The recommendations pod as the kubelet reported it in the live check. */
  const killedForMemory = (over: Partial<ContainerInfo> = {}) =>
    pod({
      status: {
        phase: "Running",
        display: "CrashLoopBackOff",
        exitUnreported: false,
        ready: false,
        conditions: [],
        message: null,
        reason: null,
      },
      containers: [
        container("app", {
          image: "busybox:1.36",
          ready: false,
          started: false,
          state: { type: "waiting", reason: "CrashLoopBackOff" },
          lastTerminated: {
            exitCode: 137,
            signal: null,
            reason: "Error",
            message: null,
            startedAt: "2026-10-06T18:57:02Z",
            finishedAt: "2026-10-06T18:57:08Z",
          },
          restartCount: 7,
          resources: {
            requests: { cpu: "5m", memory: "16Mi" },
            limits: { memory: "24Mi" },
          },
          ...over,
        }),
      ],
      volumes: [
        {
          name: "kube-api-access-7x2kq",
          source: "projected",
          refs: [{ kind: "ConfigMap", name: "kube-root-ca.crt" }],
          projections: [],
          mounts: [
            {
              container: "app",
              path: "/var/run/secrets/kubernetes.io/serviceaccount",
              readOnly: true,
              subPath: null,
            },
          ],
        },
      ],
    });

  /**
   * `sh -c "...; tail /dev/zero"` under a 24Mi limit: the kernel killed
   * tail, sh exited 137, and the kubelet said Error. The panel told Dana the
   * app exits on its own and to look at ConfigMap kube-root-ca.crt "if the
   * address is wrong". Fails if a bare exit 137 with a memory limit stops
   * getting the memory story with that limit.
   */
  it("tells the memory story for an exit 137 the kubelet called Error", () => {
    const pod = killedForMemory();
    const trouble = troubleOf(pod, []);
    expect(trouble).toMatchObject({
      reason: "oomKilled",
      container: "app",
      limit: "24Mi",
      saidOom: false,
    });
    const hint = hintFor(trouble!, pod, {
      address: null,
      servicesKnown: false,
      endpointsKnown: false,
      service: null,
      sidecar: null,
      policies: { read: "unread", why: null },
      notRead: [],
    });
    expect(hint.headline).toEqual({
      key: "guessOomUnsaid",
      values: { container: "app", limit: "24Mi" },
    });
    expect(hint.checks.map((c) => c.says.key)).toEqual([
      "checkLimits",
      "checkNode",
    ]);
  });

  /**
   * A liveness probe the kubelet acted on also ends in SIGKILL and exit
   * 137. Fails if that kill is blamed on memory.
   */
  it("leaves an exit 137 the kubelet caused for a failed liveness probe to the crash loop", () => {
    expect(
      troubleOf(killedForMemory(), [
        event(
          "Killing",
          "Container app failed liveness probe, will be restarted"
        ),
      ])?.reason
    ).toBe("crashLoop");
  });

  /** Fails if an exit 137 with no limit to blame is called a memory kill. */
  it("does not call an exit 137 a memory kill when the container has no limit", () => {
    expect(
      troubleOf(
        killedForMemory({ resources: { requests: {}, limits: {} } }),
        []
      )?.reason
    ).toBe("crashLoop");
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
          exitUnreported: false,
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
          exitUnreported: false,
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

describe("a pod the scheduler has not placed", () => {
  const unplaced = (secondsLeft: number) =>
    pod({
      nodeName: null,
      status: {
        phase: "Pending",
        display: "Pending",
        exitUnreported: false,
        ready: false,
        conditions: [],
        message: null,
        reason: null,
      },
      start: {
        state: "starting",
        until: new Date(Date.now() + secondsLeft * 1000).toISOString(),
      },
    });
  const scheduler = [
    event(
      "FailedScheduling",
      "0/2 nodes are available: 2 node(s) didn't match Pod's node affinity/selector."
    ),
  ];

  /**
   * Sam's never-placed pod, 45 s old, had a blue Pending badge over "Most
   * likely: no node fits it", which Share and Copy for agent repeated. Fails
   * if a pod inside its wait is given the fault's sentence, or one past it
   * is let off with the waiting one.
   */
  it("says a pod inside its wait is not placed yet, and one past it that no node fits", () => {
    const early = troubleOf(unplaced(15), scheduler)!;
    expect(early).toMatchObject({ reason: "pending", waiting: true });
    const said = hintFor(early, unplaced(15), NONE);
    expect(said.headline.key).toBe("notPlacedYet");
    expect(said.lines).toEqual([
      {
        key: "factSchedulerSaid",
        values: { message: scheduler[0].message },
      },
    ]);

    const late = troubleOf(unplaced(-1), scheduler)!;
    expect(late).toMatchObject({ reason: "pending", waiting: false });
    expect(hintFor(late, unplaced(-1), NONE).headline.key).toBe(
      "guessPendingSame"
    );
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
      policies: { read: "unread", why: null },
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

  /**
   * "Look at ConfigMap kube-root-ca.crt, if the address is wrong rather than
   * down" with no address anywhere in the logs. Fails if a mounted object is
   * offered as the wrong address when no address was read.
   */
  it("offers mounted config as a wrong address only when an address was read", () => {
    const hint = hintFor(troubleOf(crashing(), [])!, crashing(), {
      address: null,
      servicesKnown: true,
      endpointsKnown: true,
      service: null,
      sidecar: null,
      policies: { read: "unread", why: null },
      notRead: [],
    });
    expect(hint.checks.map((c) => c.says.key)).toEqual(["checkLastLines"]);
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
      policies: { read: "unread", why: null },
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
      policies: { read: "unread", why: null },
      notRead: ["the NetworkPolicies of shop (forbidden)"],
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
        policies: { read: "read", egress: [], ingress: [] },
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

describe("the NetworkPolicies on the way to a timed-out address", () => {
  const timedOut = () => addressIn(["dial tcp 10.43.39.231:5432: i/o timeout"]);
  const service = {
    name: "shop-db-rw",
    namespace: "shop",
    ready: 3,
    total: 3,
  };
  const hint = (policies: Chain["policies"]) =>
    hintFor(troubleOf(crashing(), [])!, crashing(), {
      ...NONE,
      address: timedOut(),
      service,
      policies,
    });

  /**
   * The sentence said "a NetworkPolicy is the usual reason, and this app
   * did not read any" while the Pod page read them. A policy on the path is
   * named, linked, and becomes the guess.
   */
  it("names the policy that restricts the path and links it", () => {
    const said = hint({
      read: "read",
      egress: ["egress-allowlist"],
      ingress: ["db-from-api"],
    });
    expect(said.headline.key).toBe("guessCrashTimeoutServicePolicy");
    expect(said.headline.values?.policies).toBe(
      "egress-allowlist, db-from-api"
    );
    expect(said.lines.map((line) => line.key)).toEqual(
      expect.arrayContaining(["factEgressRestricted", "factIngressRestricted"])
    );
    expect(
      said.checks.filter(
        (check) =>
          check.to?.kind === "object" && check.to.objectKind === "NetworkPolicy"
      )
    ).toHaveLength(2);
  });

  /** Read and nothing restricts it: said so, and the guess looks elsewhere. */
  it("says no policy restricts the path when none does", () => {
    const said = hint({ read: "read", egress: [], ingress: [] });
    expect(said.headline.key).toBe("guessCrashTimeoutServiceReady");
    expect(said.lines.map((line) => line.key)).toEqual(
      expect.arrayContaining(["factEgressOpen", "factIngressOpen"])
    );
  });

  /**
   * The thesis: policies nobody could read are not "no policy". Fails if a
   * refused read falls through to the sentence that clears them.
   */
  it("cannot say when the policies were not read", () => {
    const said = hint({ read: "unread", why: "forbidden" });
    expect(said.headline.key).toBe("guessCrashTimeoutServicePoliciesUnread");
    expect(said.lines.map((line) => line.key)).toContain("factPoliciesUnread");
    expect(said.lines.map((line) => line.key)).not.toContain("factEgressOpen");
  });

  /** Outside the cluster only this pod's egress is on the path. */
  it("says what restricts this pod's egress to an address outside", () => {
    const outside = hintFor(troubleOf(crashing(), [])!, crashing(), {
      ...NONE,
      address: addressIn(["dial tcp api.example.com:443: i/o timeout"]),
      policies: { read: "read", egress: ["egress-allowlist"], ingress: null },
    });
    expect(outside.headline.key).toBe("guessCrashTimeoutOutside");
    expect(outside.lines.map((line) => line.key)).toContain(
      "factEgressRestricted"
    );
  });

  /** A refusal is something answering: no policy line is offered for it. */
  it("leaves policies out of a refused connection", () => {
    const refused = hintFor(troubleOf(crashing(), [])!, crashing(), {
      ...NONE,
      address: addressIn([
        "dial tcp 10.43.39.231:5432: connect: connection refused",
      ]),
      service,
      policies: { read: "read", egress: ["egress-allowlist"], ingress: [] },
    });
    expect(refused.lines.map((line) => line.key)).not.toContain(
      "factEgressRestricted"
    );
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
        policies: { read: "unread", why: null },
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

  /**
   * Sam copied checkout while its container sat terminated: the report said
   * "terminated, exit 1 (Error)" over "last exit" at the run before, five
   * minutes older. Fails if the run that just ended is not the last exit,
   * if the one before it is lost, or if a restarted container whose exit
   * the kubelet did not report reads as never having exited.
   */
  it("names the run that just ended as the last exit, and says when none is reported", () => {
    const base = crashing();
    const terminated = pod({
      ...base,
      status: { ...base.status, display: "Error" },
      containers: [
        {
          ...base.containers[0],
          state: {
            type: "terminated",
            termination: {
              exitCode: 1,
              signal: null,
              reason: "Error",
              message: null,
              startedAt: "2026-09-08T10:43:55Z",
              finishedAt: "2026-09-08T10:43:59Z",
            },
          },
        },
      ],
    });
    const report = (subject: PodInfo) =>
      agentReport({
        version: "4.21.2",
        context: "acme-staging",
        at: "2026-09-08T10:44:00Z",
        pod: subject,
        trouble: null,
        logLines: [],
        logContainer: null,
        logPrevious: false,
        events: [],
        chain: NONE,
        mounts: [],
        guess: null,
      });
    const copied = report(terminated);
    expect(copied).toContain(
      "  last exit: code 1 Error, 2026-09-08T10:43:59Z · restarts 14"
    );
    expect(copied).toContain(
      "  exit before it: code 1 Error, 2026-09-08T10:38:51Z"
    );
    const unreported = pod({
      ...base,
      containers: [
        {
          ...base.containers[0],
          state: { type: "running" },
          lastTerminated: null,
        },
      ],
    });
    expect(report(unreported)).toContain(
      "  last exit: not reported by the kubelet · restarts 14"
    );
  });
});

describe("redact", () => {
  /**
   * The lines a shared report carries are what a container printed at
   * start-up, and that is env and config: a key with a prefix, a JSON key
   * with a quote before its colon. Matching only a bare `password=` let
   * `DB_PASSWORD=hunter2` out under a footer that promised otherwise.
   */
  it("takes the value out of env, logfmt, JSON and YAML keys that name a secret", () => {
    for (const line of [
      "DB_PASSWORD=hunter2",
      "MYSQL_ROOT_PASSWORD: hunter2",
      '{"password":"hunter2","user":"app"}',
      '{"apiKey": "hunter2"}',
      "client_secret=hunter2&scope=read",
      "AWS_SECRET_ACCESS_KEY=hunter2",
      "jdbc:postgresql://db:5432/app?user=svc&password=hunter2",
      "dsn=postgres://app:hunter2@db:5432/app",
    ])
      expect(redact(line)).not.toContain("hunter2");
    expect(redact('{"password":"hunter2","user":"app"}')).toBe(
      '{"password":…,"user":"app"}'
    );
  });

  /**
   * "Authorization" is a key the pattern above takes too; reading "Bearer"
   * as its value replaced the word and left the token beside it.
   */
  it("takes out the token after Bearer, not the word Bearer", () => {
    expect(redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).toBe(
      "Authorization: Bearer …"
    );
  });

  /** Tokens that say what they are by their first letters, with no key in front. */
  it("takes out access key ids and prefixed tokens standing alone", () => {
    expect(redact("aws key AKIAIOSFODNN7EXAMPLE")).toBe("aws key …");
    expect(redact("using ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(
      "using …"
    );
  });

  /** A line with nothing secret in it reaches the reader as it was written. */
  it("leaves an ordinary line alone", () => {
    const line = 'time=2026-09-28T23:14:09Z level=info msg="ok" port=8080';
    expect(redact(line)).toBe(line);
  });
});
