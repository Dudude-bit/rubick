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
} from "./forwarded";
import type { ServiceInfo } from "@/generated/types";

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

const pod = (name: string, ready: boolean, phase = "Running") =>
  ({ name, status: { phase, ready } }) as never;

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
      expect(list[0].because).toContain("labelled");
      expect(list[1].because).toBe("named for it");
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
      pod("gone", false, "Succeeded"),
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
    expect(found[0].because).toBe("its gateway");
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
    expect(only.because).toContain("labelled");
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
