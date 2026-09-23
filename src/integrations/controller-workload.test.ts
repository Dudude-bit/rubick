import { beforeEach, describe, expect, it, vi } from "vitest";

const { commands } = vi.hoisted(() => ({
  commands: {
    listDeployments: vi.fn(),
    listDaemonsets: vi.fn(),
    getManifest: vi.fn(),
    getConfigmapData: vi.fn(),
  },
}));
vi.mock("@/lib/commands", () => ({ commands }));

import type { IngressInfo, ServiceInfo } from "@/generated/types";
import { findControllerWorkload } from "./ingress";
import { fetchController } from "./ingress-nginx/data";
import { frontingIngresses, terminatedUpstream } from "./ingress-nginx/model";

const daemonSet = {
  name: "ingress-nginx-controller",
  namespace: "ingress-nginx",
  desired: 3,
  current: 3,
  ready: 3,
  updated: 3,
  containerImages: [
    {
      name: "controller",
      image: "registry.k8s.io/ingress-nginx/controller:v1.11.2",
    },
  ],
};

beforeEach(() => {
  for (const fn of Object.values(commands)) fn.mockReset();
  commands.listDeployments.mockResolvedValue([]);
  commands.listDaemonsets.mockResolvedValue([daemonSet]);
  commands.getManifest.mockResolvedValue(
    "spec:\n  template:\n    spec:\n      containers:\n        - args: []\n"
  );
});

describe("finding a proxy's controller", () => {
  /**
   * ingress-nginx's chart installs a DaemonSet as readily as a Deployment,
   * and the page read Deployments alone: a running controller was "not
   * found", and the reader was told to install one.
   */
  it("finds a controller that runs as a DaemonSet", async () => {
    const found = await findControllerWorkload("app=nginx");
    expect(found.workload).toMatchObject({
      kind: "DaemonSet",
      name: "ingress-nginx-controller",
      image: "registry.k8s.io/ingress-nginx/controller:v1.11.2",
    });
  });

  it("reads the DaemonSet's own manifest for its flags", async () => {
    const info = await fetchController();
    expect(info.workload?.kind).toBe("DaemonSet");
    expect(commands.getManifest).toHaveBeenCalledWith(
      "DaemonSet",
      "apps/v1",
      "ingress-nginx-controller",
      "ingress-nginx"
    );
  });

  /** One refused list and one empty one is "could not look", not "none". */
  it("keeps a refusal rather than reporting no controller", async () => {
    commands.listDaemonsets.mockResolvedValue([]);
    commands.listDeployments.mockRejectedValue(
      new Error("deployments.apps is forbidden")
    );
    const found = await findControllerWorkload("app=nginx");
    expect(found).toEqual({
      workload: null,
      refused: "deployments.apps is forbidden",
    });
  });
});

const proxy = {
  name: "ingress-nginx-controller",
  namespace: "ingress-nginx",
  selector: { "app.kubernetes.io/name": "ingress-nginx" },
} as unknown as ServiceInfo;

const loadBalancer = {
  name: "edge",
  namespace: "ingress-nginx",
  rules: [],
  defaultBackend: {
    backendService: "ingress-nginx-controller",
    backendPort: "80",
  },
  tlsHosts: ["shop.example.com"],
  tlsConfigs: [],
  hasCatchAllTls: false,
} as unknown as IngressInfo;

describe("what stands in front of nginx", () => {
  /**
   * A cloud load balancer's Ingress names no rules and sends everything to
   * the proxy through `spec.defaultBackend`. Traefik read that; nginx read
   * rules alone, so on a managed cluster every host looked served in the
   * clear.
   */
  it("counts an Ingress that fronts the proxy through its default backend", () => {
    const sources = {
      ingresses: [loadBalancer],
      services: [proxy],
    } as unknown as Parameters<typeof frontingIngresses>[0];
    expect(frontingIngresses(sources)).toEqual([loadBalancer]);
    expect(terminatedUpstream("shop.example.com", sources)).toEqual({
      kind: "Ingress",
      name: "edge",
      namespace: "ingress-nginx",
    });
    expect(terminatedUpstream("other.example.com", sources)).toBeNull();
  });
});
