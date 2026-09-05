import { describe, expect, it } from "vitest";

import {
  RANGE_SPECS,
  cpuQuery,
  escapeLabel,
  escapeRegex,
  memoryQuery,
  podPattern,
  restartQuery,
  trafficQuery,
  volumeCapacityQuery,
  volumeUsedQuery,
} from "./queries";
import { USAGE_RANGES, type UsageScope } from "../registry";

const pod: UsageScope = {
  kind: "pod",
  namespace: "k8s-gui-test",
  pod: "busy-demo-cb8d8b486-4r2jl",
};
const workload: UsageScope = {
  kind: "workload",
  namespace: "k8s-gui-test",
  owner: "busy-demo",
  ownerKind: "Deployment",
};
const node: UsageScope = { kind: "node", node: "k3d-k8s-gui-dev-agent-0" };

const HOUR = RANGE_SPECS["1h"];

describe("CPU", () => {
  /**
   * cAdvisor emits three series for a one-container pod — the pod cgroup
   * roll-up, the pause container and the real container — and only the last
   * carries a `container` label on containerd. Summing without the filter
   * reads `busy-demo` at 40m; with it, at 20m; `kubectl top pod` says 20m.
   * Losing this filter doubles every number on every chart, plausibly, and
   * nothing else would notice.
   */
  it("counts a container once, not once per cgroup cAdvisor happens to walk", () => {
    const query = cpuQuery(pod, HOUR);
    expect(query).toContain('container!=""');
    expect(query).toContain('container!="POD"');
  });

  /** Cores out of `rate`, millicores everywhere else in this app. */
  it("answers in millicores, because every other reading here is", () => {
    expect(cpuQuery(pod, HOUR)).toMatch(/\* 1000$/);
  });

  /**
   * Would break if a bucket started reporting whatever the series read at its
   * own boundary — which is how a chart loses the thirty seconds that got a
   * container OOM-killed, silently and while still looking plausible.
   */
  it("takes the peak inside a bucket, never the value at its edge", () => {
    for (const range of USAGE_RANGES) {
      const spec = RANGE_SPECS[range];
      const query = cpuQuery(pod, spec);
      if (spec.inner === null) {
        // The shortest range's bucket *is* the scrape resolution: there is
        // nothing finer to take a maximum over, and the label says so.
        expect(query).not.toContain("max_over_time");
        expect(spec.resolution).toMatch(/at the scrape resolution/);
      } else {
        expect(query).toContain(
          `max_over_time((sum(rate(container_cpu_usage_seconds_total`
        );
        expect(query).toContain(`[${spec.stepSeconds}s:${spec.inner}])`);
        expect(spec.resolution).toMatch(/max over a/);
      }
    }
  });

  /**
   * Would break if the node band started depending on how somebody else's
   * Prometheus happens to relabel its kubelet job. Three spellings are in the
   * wild and picking one would be the sniffing this app refuses.
   */
  it("asks for a node by every label that names one", () => {
    const query = cpuQuery(node, HOUR);
    for (const label of ["instance", "node", "kubernetes_io_hostname"]) {
      expect(query).toContain(`${label}="k3d-k8s-gui-dev-agent-0"`);
    }
    expect(query).toContain('id="/"');
  });
});

describe("memory", () => {
  /**
   * Would break if the chart moved off the number the OOM killer acts on.
   * `container_memory_usage_bytes` includes reclaimable page cache and reads
   * far higher; a chart drawn from it disagrees with `kubectl top` and with
   * the kill that actually happens.
   */
  it("is the working set, which is what kubectl top and the OOM killer use", () => {
    expect(memoryQuery(pod, HOUR)).toContain(
      "container_memory_working_set_bytes"
    );
    expect(memoryQuery(pod, HOUR)).not.toContain(
      "container_memory_usage_bytes"
    );
  });

  /** A gauge needs no rate, and taking one would report bytes per second. */
  it("does not rate a gauge", () => {
    expect(memoryQuery(pod, HOUR)).not.toContain("rate(");
  });

  it("takes the peak inside a bucket", () => {
    expect(memoryQuery(pod, HOUR)).toContain("max_over_time(");
    expect(memoryQuery(pod, RANGE_SPECS["6h"])).toContain("[180s:30s])");
  });
});

describe("restarts", () => {
  /**
   * Would break if the restart marker started needing kube-state-metrics.
   * `container_start_time_seconds` is cAdvisor's and is on every cluster that
   * can answer any of these queries at all; making the marker depend on a
   * second install nobody was asked for would lose it on most of them.
   */
  it("reads a restart off cAdvisor rather than off a second install", () => {
    const query = restartQuery(pod, HOUR);
    expect(query).toContain("changes(container_start_time_seconds");
    expect(query).not.toContain("kube_pod_container_status_restarts_total");
  });

  /** Attributed to the bucket it happened in, not smeared over a rate window. */
  it("counts over the bucket, so the mark lands where the restart did", () => {
    expect(restartQuery(pod, HOUR)).toContain(`[${HOUR.stepSeconds}s]`);
  });

  /** A node does not restart, so nothing is asked and no mark is drawn. */
  it("asks nothing of a node", () => {
    expect(restartQuery(node, HOUR)).toBe("");
  });
});

describe("volume fullness", () => {
  /**
   * Would break if fullness started arriving as a ratio. The row states used
   * *and* capacity because the kubelet's capacity is the filesystem behind
   * the volume — for `local-path` or `hostPath` that is the node's whole
   * disk, and a bare percentage would be read as a share of the declared
   * size, which it is not.
   */
  it("asks for both numbers, never for the ratio", () => {
    expect(volumeUsedQuery("k8s-gui-test", ["pvc-demo"])).toContain(
      "kubelet_volume_stats_used_bytes"
    );
    expect(volumeCapacityQuery("k8s-gui-test", ["pvc-demo"])).toContain(
      "kubelet_volume_stats_capacity_bytes"
    );
    expect(volumeUsedQuery("k8s-gui-test", ["pvc-demo"])).not.toContain("/");
  });

  /**
   * Would break if a claim named `data` started matching `data-0` — the
   * alternation is anchored, so one claim's fullness cannot be printed
   * against another's row.
   */
  it("matches a claim's whole name and not a prefix of it", () => {
    const query = volumeUsedQuery("k8s-gui-test", ["data", "data-0"]);
    expect(query).toContain('persistentvolumeclaim=~"^(data|data-0)$"');
  });
});

describe("traffic", () => {
  /**
   * The exception that inverts the CPU rule above: every container in a pod
   * shares one network namespace, so cAdvisor reports traffic only on the
   * sandbox — the very series `container!=""` throws away. Applying the CPU
   * filter here returns nothing at all, and an empty chart reads as a silent
   * pod.
   */
  it("does not filter out the sandbox, which is where the counters live", () => {
    const query = trafficQuery(pod, HOUR, "receive");
    expect(query).toContain("container_network_receive_bytes_total");
    expect(query).not.toContain('container!=""');
  });

  /** A pod talking to itself is not traffic. */
  it("leaves loopback out", () => {
    expect(trafficQuery(pod, HOUR, "transmit")).toContain('interface!="lo"');
  });

  /** No core answer means no row, so a node asks nothing. */
  it("asks nothing of a node", () => {
    expect(trafficQuery(node, HOUR, "receive")).toBe("");
  });
});

describe("scope across a rollout", () => {
  /**
   * A Deployment's pods are `<name>-<replicaset hash>-<suffix>` and the hash
   * changes on every rollout, so a pattern built from the *current*
   * ReplicaSet would draw a chart that goes blank at the last deploy — the
   * exact moment the reader came to look at. Leaving both trailing segments
   * open spans every generation the workload has had, and the rollout shows
   * as a bump where both briefly run rather than as a gap.
   */
  it("spans the generations a Deployment has had, hash and all", () => {
    const pattern = new RegExp(podPattern("Deployment", "busy-demo"));
    expect(pattern.test("busy-demo-cb8d8b486-4r2jl")).toBe(true);
    // The previous ReplicaSet, whose pods are what "an hour ago" is made of.
    expect(pattern.test("busy-demo-7f9c4d5b21-x2ktp")).toBe(true);
  });

  /**
   * Would break if a Deployment started claiming a differently-named
   * Deployment's pods — the one way this pattern could report a confident,
   * wrong number.
   */
  it("does not claim the pods of a longer name that starts the same", () => {
    const pattern = new RegExp(podPattern("Deployment", "busy"));
    expect(pattern.test("busy-demo-cb8d8b486-4r2jl")).toBe(false);
  });

  /** A StatefulSet's ordinal is stable, which is its whole promise. */
  it("names a StatefulSet's pods by their ordinal", () => {
    const pattern = new RegExp(podPattern("StatefulSet", "stateful-demo"));
    expect(pattern.test("stateful-demo-0")).toBe(true);
    expect(pattern.test("stateful-demo-abc-def")).toBe(false);
  });

  /** A CronJob is two indirections: the Job, then the pod. */
  it("reaches through a CronJob's Jobs to their pods", () => {
    const pattern = new RegExp(podPattern("CronJob", "backup"));
    expect(pattern.test("backup-28901234-vk2mn")).toBe(true);
  });

  /** A DaemonSet names its pods directly. */
  it("names a DaemonSet's pods directly", () => {
    const pattern = new RegExp(podPattern("DaemonSet", "daemon-demo"));
    expect(pattern.test("daemon-demo-75zdk")).toBe(true);
  });

  /**
   * Would break if a dot in a name stayed a regex wildcard — a Deployment
   * called `a.b` would then also claim the pods of one called `axb`.
   */
  it("escapes the one regex metacharacter a Kubernetes name may contain", () => {
    expect(escapeRegex("a.b")).toBe("a\\.b");
    const pattern = new RegExp(podPattern("Deployment", "a.b"));
    expect(pattern.test("axb-hash-suffix")).toBe(false);
    expect(pattern.test("a.b-hash-suffix")).toBe(true);
  });

  /** A label value ends at a quote, so one in a value must not end it. */
  it("escapes what would end a label value early", () => {
    expect(escapeLabel('say "hi"')).toBe('say \\"hi\\"');
    expect(escapeLabel("back\\slash")).toBe("back\\\\slash");
  });

  it("selects a workload by shape and a pod by name", () => {
    expect(cpuQuery(workload, HOUR)).toContain(
      'pod=~"^busy-demo-[^-]+-[^-]+$"'
    );
    expect(cpuQuery(pod, HOUR)).toContain('pod="busy-demo-cb8d8b486-4r2jl"');
  });
});

describe("the ranges", () => {
  /**
   * Would break if a range started drawing more points than the band has
   * pixels, or so few the line became a sketch. ~120 buckets is what the
   * watched window already draws at, and both charts must be the same
   * picture at different scales.
   */
  it("draws every range at about the same number of buckets", () => {
    for (const range of USAGE_RANGES) {
      const spec = RANGE_SPECS[range];
      const points = spec.windowMs / 1000 / spec.stepSeconds;
      expect(points).toBeGreaterThanOrEqual(60);
      expect(points).toBeLessThanOrEqual(120);
    }
  });

  /**
   * Would break if a rate window shrank below two scrape intervals, where
   * `rate` has nothing to divide and answers with gaps that read as downtime.
   */
  it("keeps the rate window wide enough to have something to divide", () => {
    for (const range of USAGE_RANGES) {
      const spec = RANGE_SPECS[range];
      const seconds = Number(spec.rateWindow.replace("m", "")) * 60;
      expect(seconds).toBeGreaterThanOrEqual(60);
    }
  });

  /** Every range says what a bucket is worth, because that is the contract. */
  it("names its own resolution", () => {
    for (const range of USAGE_RANGES) {
      expect(RANGE_SPECS[range].resolution).toMatch(/bucket/);
    }
  });
});
