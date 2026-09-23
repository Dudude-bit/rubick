import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomResourceInfo, IngressInfo } from "@/generated/types";

const answers = vi.hoisted(() => ({
  certificates: (): Promise<unknown[]> => Promise.resolve([]),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    listIngresses: () => Promise.resolve([shop]),
    listCustomResources: (crd: string) =>
      crd.startsWith("managedcertificates")
        ? answers.certificates()
        : Promise.resolve([]),
  },
}));

const { ingressTls } = await import("./ingress-tls");

const shop: IngressInfo = {
  name: "shop",
  namespace: "web",
  className: null,
  rules: [],
  loadBalancerIps: [],
  tlsHosts: [],
  tlsConfigs: [],
  hasCatchAllTls: false,
  defaultBackend: {
    backendService: "traefik",
    backendPort: "80",
    resourceBackend: null,
  },
  labels: {},
  annotations: {
    "kubernetes.io/ingress.class": "gce",
    "networking.gke.io/managed-certificates": "pending-cert,shop-cert",
  },
  createdAt: null,
};

const certificate = (name: string, status: string): CustomResourceInfo =>
  ({
    name,
    namespace: "web",
    spec: { domains: ["shop.example.com"] },
    status: { certificateStatus: status },
  }) as unknown as CustomResourceInfo;

const ask = async () =>
  (
    await ingressTls([
      { namespace: "web", name: "shop", hosts: ["shop.example.com"] },
    ])
  )[0];

beforeEach(() => {
  answers.certificates = () => Promise.resolve([]);
});

describe("whether GKE serves an Ingress's host over TLS", () => {
  /**
   * With `managedcertificates` refused the named certificate could not be
   * found, the answer was silence, and `spec.tls` — empty on GKE — made
   * every surface say "no TLS". Fails if the unread list is read as none.
   */
  it("could not say when the certificates it names could not be listed", async () => {
    answers.certificates = () =>
      Promise.reject(
        new Error("managedcertificates.networking.gke.io is forbidden", {
          cause: { code: "PERMISSION_DENIED" },
        })
      );

    expect(await ask()).toEqual([
      expect.objectContaining({ host: "shop.example.com", terminated: null }),
    ]);
  });

  /** The certificates read and none covering the host is silence, not a shrug. */
  it("leaves a host no readable certificate covers to spec.tls", async () => {
    answers.certificates = () =>
      Promise.resolve([
        { ...certificate("shop-cert", "Active"), spec: { domains: [] } },
      ]);

    expect(await ask()).toEqual([]);
  });

  /**
   * The first certificate still provisioning ended the question, so a second
   * one already `Active` for the same host was never looked at and the host
   * read as plain HTTP.
   */
  it("passes over a certificate still provisioning to one that is active", async () => {
    answers.certificates = () =>
      Promise.resolve([
        certificate("pending-cert", "Provisioning"),
        certificate("shop-cert", "Active"),
      ]);

    expect(await ask()).toEqual([
      expect.objectContaining({ host: "shop.example.com", terminated: true }),
    ]);
  });
});
