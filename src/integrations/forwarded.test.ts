/**
 * Forwarding to an in-cluster server instead of asking for an address that
 * only the cluster can resolve.
 *
 * The pinned thing here is the failure the naive version has: `port_forward_pod`
 * forwards to a pod *by name* and `autoReconnect` retries that same pod, so a
 * rollout leaves the forward chasing something that no longer exists behind a
 * `localhost` URL that used to work.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/commands", () => ({
  commands: {
    listServices: vi.fn(),
    listPods: vi.fn(),
    listPortForwards: vi.fn(async () => []),
    listPortForwardConfigs: vi.fn(async () => []),
    portForwardPod: vi.fn(async () => ({})),
    stopPortForward: vi.fn(async () => undefined),
  },
}));

import { commands } from "@/lib/commands";
import {
  candidates,
  forward,
  freePort,
  podFor,
  portOf,
  reestablish,
  normalisedSubpath,
} from "./forwarded";
import type { ServiceInfo } from "@/generated/types";

import { translate } from "@/i18n";
import { sayWords } from "@/i18n/say";
import type { T } from "@/i18n/useT";

/** The English catalogue — what these expectations are written in. */
const t: T = (section, key, values) => translate("en", section, key, values);

const service = (
  name: string,
  namespace: string,
  ports: number[],
  labels: Record<string, string> = {}
): ServiceInfo =>
  ({
    name,
    namespace,
    uid: name,
    type: "ClusterIP",
    selector: { app: name },
    labels,
    annotations: {},
    ports: ports.map((port) => ({
      name: null,
      port,
      targetPort: String(port),
      nodePort: null,
      protocol: "TCP",
    })),
    clusterIp: "10.0.0.1",
    externalIps: [],
    loadBalancerIps: [],
    sessionAffinity: "None",
    createdAt: null,
  }) as ServiceInfo;

type FakeContainer = {
  phase?: "app" | "init" | "sidecar";
  state: { type: string; reason?: string };
};

/**
 * A pod is somewhere to forward to when one of its own containers is up.
 * `display` is what kubectl prints for it: the first container that is not
 * running names the whole pod, which is exactly why it cannot be the test.
 */
const pod = (
  name: string,
  ready: boolean,
  containers: FakeContainer[] = [{ state: { type: "running" } }]
) => {
  const stuck = containers.find((c) => c.state.type !== "running");
  const display = stuck ? (stuck.state.reason ?? "Error") : "Running";
  return {
    name,
    status: { phase: "Running", display, ready },
    containers: containers.map((container) => ({
      phase: "app",
      ...container,
    })),
  } as never;
};

beforeEach(() => {
  vi.mocked(commands.listServices).mockReset();
  vi.mocked(commands.listPods).mockReset();
  vi.mocked(commands.portForwardPod).mockClear();
  vi.mocked(commands.stopPortForward).mockClear();
  vi.mocked(commands.listPortForwards).mockResolvedValue([]);
  vi.mocked(commands.listPortForwardConfigs).mockResolvedValue([]);
});

describe("which port to forward", () => {
  it("prefers the vendor's own", () => {
    expect(portOf(service("prom", "mon", [8080, 9090]), [9090])).toBe(9090);
  });

  it("takes the only port a Service has", () => {
    expect(portOf(service("prom", "mon", [1234]), [9090])).toBe(1234);
  });

  /** Guessing between several would forward the wrong one silently. */
  it("refuses to choose between several it does not recognise", () => {
    expect(portOf(service("prom", "mon", [1234, 5678]), [9090])).toBeNull();
  });
});

describe("finding the vendor in the cluster", () => {
  it("ranks a labelled Service above one that merely has the name", () => {
    vi.mocked(commands.listServices).mockResolvedValue([
      service("prometheus-copy", "team", [9090]),
      service("kube-prom-stack", "mon", [9090], {
        "app.kubernetes.io/name": "prometheus",
      }),
    ]);

    const found = candidates({ names: ["prometheus"], ports: [9090] });
    return found.then((list) => {
      expect(list[0].service.name).toBe("kube-prom-stack");
      expect(sayWords(list[0].because, t)).toContain("labelled");
      expect(sayWords(list[1].because, t)).toBe("named for it");
    });
  });

  /** Offering something that cannot be forwarded is offering a dead end. */
  it("leaves out a match whose ports it cannot choose between", () => {
    vi.mocked(commands.listServices).mockResolvedValue([
      service("prometheus", "mon", [1234, 5678]),
    ]);
    return expect(
      candidates({ names: ["prometheus"], ports: [9090] })
    ).resolves.toEqual([]);
  });
});

describe("which pod to forward to", () => {
  it("prefers a ready pod and settles for a running one", async () => {
    vi.mocked(commands.listPods).mockResolvedValue([
      pod("starting", false),
      pod("serving", true),
    ]);
    expect(await podFor(service("prom", "mon", [9090]))).toBe("serving");

    vi.mocked(commands.listPods).mockResolvedValue([pod("starting", false)]);
    expect(await podFor(service("prom", "mon", [9090]))).toBe("starting");
  });

  it("ignores a pod that is not running at all", async () => {
    vi.mocked(commands.listPods).mockResolvedValue([
      pod("gone", false, [{ state: { type: "terminated" } }]),
    ]);
    expect(await podFor(service("prom", "mon", [9090]))).toBeNull();
  });

  /**
   * A crash-looping pod is in phase Running, and this used to read the
   * phase: with no ready pod behind the Service it forwarded onto the one
   * container that was not there, and the metrics tab showed a connection
   * refused instead of saying nothing was up.
   */
  it("does not settle for a pod that is crash-looping", async () => {
    vi.mocked(commands.listPods).mockResolvedValue([
      pod("looping", false, [
        { state: { type: "waiting", reason: "CrashLoopBackOff" } },
      ]),
    ]);
    expect(await podFor(service("prom", "mon", [9090]))).toBeNull();
  });

  /**
   * The crash-loop fix first read kubectl's whole-pod status, and that
   * refused a prometheus whose config-reloader sidecar sat in
   * ImagePullBackOff while 9090 answered. The verdict is the container's.
   */
  it("forwards to a pod whose sidecar is broken while its own container is up", async () => {
    vi.mocked(commands.listPods).mockResolvedValue([
      pod("serving", false, [
        { state: { type: "running" } },
        {
          phase: "sidecar",
          state: { type: "waiting", reason: "ImagePullBackOff" },
        },
      ]),
    ]);
    expect(await podFor(service("prom", "mon", [9090]))).toBe("serving");
  });

  /** An init container that is still running is setting the pod up, not serving. */
  it("does not count a running init container", async () => {
    vi.mocked(commands.listPods).mockResolvedValue([
      pod("initialising", false, [
        { phase: "init", state: { type: "running" } },
        { state: { type: "waiting", reason: "PodInitializing" } },
      ]),
    ]);
    expect(await podFor(service("prom", "mon", [9090]))).toBeNull();
  });
});

describe("a local port", () => {
  /** Above the ephemeral range, or the kernel hands it out later as a source port. */
  it("is taken from a range the kernel will not reuse", () => {
    expect(freePort(new Set())).toBeGreaterThanOrEqual(20000);
  });

  it("skips what this app is already forwarding", () => {
    expect(freePort(new Set([20000, 20001]))).toBe(20002);
  });
});

describe("keeping the forward alive across a rollout", () => {
  /**
   * The reason `reestablish` exists. `autoReconnect` retries the pod it was
   * given; when that pod is gone for good the forward is chasing nothing, and
   * the saved `localhost` URL keeps looking fine.
   */
  it("moves to a new pod without changing the local port", async () => {
    vi.mocked(commands.listPods).mockResolvedValue([pod("prom-old", true)]);
    const svc = service("prom", "mon", [9090]);
    const first = await forward(svc, [9090]);
    expect(first.url).toBe(`http://localhost:${first.localPort}`);
    expect(first.pod).toBe("prom-old");

    vi.mocked(commands.listPortForwards).mockResolvedValue([
      { id: "s1", localPort: first.localPort } as never,
    ]);
    vi.mocked(commands.listPods).mockResolvedValue([pod("prom-new", true)]);

    const again = await reestablish(first, svc);
    expect(again.pod).toBe("prom-new");
    // The address the connection is saved under must not move under it.
    expect(again.localPort).toBe(first.localPort);
    expect(again.url).toBe(first.url);
    expect(commands.stopPortForward).toHaveBeenCalledWith("s1");
  });

  it("says so when nothing is behind the Service any more", async () => {
    vi.mocked(commands.listPods).mockResolvedValue([]);
    await expect(
      reestablish(
        {
          namespace: "mon",
          service: "prom",
          remotePort: 9090,
          localPort: 20000,
          pod: "prom-old",
          subpath: "",
          url: "http://localhost:20000",
        },
        service("prom", "mon", [9090])
      )
    ).rejects.toThrow(/No running pod/);
  });
});

describe("choosing between the Services one chart installs", () => {
  const LOKI = {
    names: ["loki"],
    ports: [3100],
    prefer: ["gateway", "query-frontend", "read"],
    avoid: ["write", "ingester", "compactor", "index-gateway"],
  };

  /**
   * The failure this exists to stop. A Loki chart puts up five Services all
   * labelled `loki`; the write path answers HTTP perfectly and cannot answer
   * a query, so a connection to it establishes and every log range comes
   * back empty.
   */
  it("never offers a component that cannot answer a query", async () => {
    vi.mocked(commands.listServices).mockResolvedValue([
      service("loki-write", "mon", [3100]),
      service("loki-ingester", "mon", [3100]),
      service("loki-compactor", "mon", [3100]),
    ]);

    await expect(candidates(LOKI)).resolves.toEqual([]);
  });

  it("puts the gateway first and the read path after it", async () => {
    vi.mocked(commands.listServices).mockResolvedValue([
      service("loki-read", "mon", [3100]),
      service("loki-gateway", "mon", [3100]),
      service("loki-write", "mon", [3100]),
    ]);

    const found = await candidates(LOKI);
    expect(found.map((entry) => entry.service.name)).toEqual([
      "loki-gateway",
      "loki-read",
    ]);
    expect(sayWords(found[0].because, t)).toBe('its "gateway" component');
  });

  /** An `index-gateway` is not a gateway, and `avoid` is checked first. */
  it("does not mistake the index gateway for the front door", async () => {
    vi.mocked(commands.listServices).mockResolvedValue([
      service("loki-index-gateway", "mon", [3100]),
    ]);
    await expect(candidates(LOKI)).resolves.toEqual([]);
  });

  /** A single-binary install has one Service and no component in its name. */
  it("still offers a plainly named Service", async () => {
    vi.mocked(commands.listServices).mockResolvedValue([
      service("loki", "mon", [3100], { "app.kubernetes.io/name": "loki" }),
    ]);
    const [only] = await candidates(LOKI);
    expect(only.service.name).toBe("loki");
    expect(sayWords(only.because, t)).toContain("labelled");
  });

  /**
   * `kube-prometheus-stack` names Alertmanager and the exporters after
   * Prometheus, and all of them answer HTTP on a port.
   */
  it("leaves the rest of a kube-prometheus-stack alone", async () => {
    vi.mocked(commands.listServices).mockResolvedValue([
      service("kube-prometheus-stack-alertmanager", "mon", [9093]),
      service("kube-prometheus-stack-prometheus-node-exporter", "mon", [9100]),
      service("prometheus-operated", "mon", [9090]),
    ]);

    const found = await candidates({
      names: ["prometheus"],
      ports: [9090],
      prefer: ["operated"],
      avoid: ["alertmanager", "node-exporter", "kube-state-metrics"],
    });
    expect(found.map((entry) => entry.service.name)).toEqual([
      "prometheus-operated",
    ]);
  });

  /**
   * The same chart also wraps the control plane's own metrics endpoints in
   * Services named for it — coredns, etcd, kube-proxy, the scheduler — and
   * every one answers `/metrics` and cannot answer a PromQL query. No
   * `avoid` list can keep up with that family, but none of them carries the
   * vendor's own port: a name-substring match without it is a row that
   * connects and then answers nothing.
   */
  it("does not offer scrape targets that merely carry the vendor's name", async () => {
    vi.mocked(commands.listServices).mockResolvedValue([
      service("stack-kube-prometheus-stac-coredns", "kube-system", [9153]),
      service("stack-kube-prometheus-stac-kube-etcd", "kube-system", [2381]),
      service("stack-kube-prometheus-stac-kube-proxy", "kube-system", [10249]),
      service("stack-kube-prometheus-stac-prometheus", "mon", [9090]),
    ]);

    const found = await candidates({ names: ["prometheus"], ports: [9090] });
    expect(found.map((entry) => entry.service.name)).toEqual([
      "stack-kube-prometheus-stac-prometheus",
    ]);
  });

  /**
   * A label is the chart's own word and outranks the port heuristic: a
   * Prometheus published on a nonstandard port is still a Prometheus.
   */
  it("keeps a labelled Service on a nonstandard port", async () => {
    vi.mocked(commands.listServices).mockResolvedValue([
      service("prom-custom", "mon", [8481], {
        "app.kubernetes.io/name": "prometheus",
      }),
    ]);

    const found = await candidates({ names: ["prometheus"], ports: [9090] });
    expect(found.map((entry) => entry.service.name)).toEqual(["prom-custom"]);
  });
});

describe("keeping the address a connection was saved under", () => {
  const svc = () => service("prom", "mon", [9090]);

  beforeEach(() => {
    vi.mocked(commands.listPods).mockResolvedValue([pod("prom-1", true)]);
  });

  /** The saved address is `http://localhost:<port>`, so the port is tried first. */
  it("keeps the wanted port when the machine will give it", async () => {
    const found = await forward(svc(), [9090], 20500);
    expect(found.localPort).toBe(20500);
    expect(commands.portForwardPod).toHaveBeenCalledWith(
      "prom-1",
      "mon",
      expect.objectContaining({ localPort: 20500 })
    );
  });

  /**
   * `portsInUse` only knows what this app is forwarding, so the kernel is the
   * authority: the wanted port is attempted and a free one is chosen only
   * after it actually refuses to bind.
   */
  it("moves to a free port when the machine refuses the wanted one", async () => {
    vi.mocked(commands.portForwardPod).mockRejectedValueOnce(
      new Error("address already in use")
    );

    const found = await forward(svc(), [9090], 20500);
    expect(found.localPort).not.toBe(20500);
    expect(found.localPort).toBeGreaterThanOrEqual(20000);
    expect(found.url).toBe(`http://localhost:${found.localPort}`);
  });

  /** The port it just failed on is not offered again as the fallback. */
  it("does not fall back onto the port that just refused", async () => {
    vi.mocked(commands.portForwardPod).mockRejectedValueOnce(
      new Error("address already in use")
    );
    const found = await forward(svc(), [9090], 20000);
    expect(found.localPort).not.toBe(20000);
  });
});

describe("an API that does not sit at the root", () => {
  /**
   * Why this exists at all (#71). Prometheus answers `/api/v1/query` straight
   * off the host, so a forward's address could stop at the port. A
   * VictoriaMetrics does not: VMSingle serves the same API under
   * `/prometheus`, and a VMCluster's vmselect under `/select/<tenant>/…`.
   * The app cannot read which from the Service, so it is carried.
   */
  it("puts the subpath after the port, where the query path is appended", () => {
    expect(normalisedSubpath("/prometheus")).toBe("/prometheus");
  });

  it("takes one without the leading slash, because people type it that way", () => {
    expect(normalisedSubpath("prometheus")).toBe("/prometheus");
    expect(normalisedSubpath("  select/0/prometheus  ")).toBe(
      "/select/0/prometheus"
    );
  });

  /**
   * A trailing slash would make the address `…/prometheus//api/v1/query`.
   * Some servers forgive that and some answer 404; none of them should have to.
   */
  it("drops a trailing slash rather than doubling it against the query path", () => {
    expect(normalisedSubpath("/prometheus/")).toBe("/prometheus");
    expect(normalisedSubpath("/prometheus///")).toBe("/prometheus");
  });

  it("is empty for an API at the root, and for nothing at all", () => {
    expect(normalisedSubpath("")).toBe("");
    expect(normalisedSubpath("   ")).toBe("");
    expect(normalisedSubpath(undefined)).toBe("");
    expect(normalisedSubpath("/")).toBe("");
  });
});

describe("forwarding to something that only speaks the API", () => {
  beforeEach(() => {
    vi.mocked(commands.listPods).mockResolvedValue([pod("vmsingle-0", true)]);
    vi.mocked(commands.listPortForwards).mockResolvedValue([]);
  });

  /**
   * The whole of #71 in one assertion. A VictoriaMetrics is not called
   * prometheus, wears no prometheus label and does not listen on 9090 — the
   * search cannot find it — and its query API is not at the root, so the
   * address the forward hands back has to carry the subpath or every query
   * 404s against a connection that tested green.
   */
  it("builds the address with the subpath, not just the port", async () => {
    const found = await forward(
      service("vmsingle-victoria-metrics-k8s-stack", "monitoring", [8428]),
      [8428],
      undefined,
      "/prometheus"
    );
    expect(found.url).toBe(`http://localhost:${found.localPort}/prometheus`);
    expect(found.subpath).toBe("/prometheus");
  });

  /** A plain Prometheus is unchanged: no subpath, no trailing anything. */
  it("leaves an API at the root exactly where it was", async () => {
    const found = await forward(service("prom", "mon", [9090]), [9090]);
    expect(found.url).toBe(`http://localhost:${found.localPort}`);
    expect(found.subpath).toBe("");
  });

  /**
   * The port comes from the form, not from the vendor's guess: 8428 is not in
   * Prometheus's list, and picking a Service by hand is exactly the case
   * where the app has no opinion about which port is the right one.
   */
  it("forwards the port it was given rather than one it recognises", async () => {
    const found = await forward(
      service("vmselect", "monitoring", [8481, 8482]),
      [8481],
      undefined,
      "select/0/prometheus"
    );
    expect(found.remotePort).toBe(8481);
    expect(found.url).toBe(
      `http://localhost:${found.localPort}/select/0/prometheus`
    );
  });
});
