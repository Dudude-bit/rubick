import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { IngressInfo } from "@/generated/types";

vi.mock("@/lib/commands", () => ({
  commands: {
    listIngresses: vi.fn(async () => []),
    resolveIngressClass: vi.fn(async () => ({
      available: [
        {
          name: "traefik",
          controller: "traefik.io/ingress-controller",
          isDefault: false,
          parameters: null,
        },
      ],
    })),
  },
}));
vi.mock("./data", () => ({ fetchController: vi.fn() }));

import { commands } from "@/lib/commands";
import { fetchController } from "./data";
import { ingressTls } from "./ingress-tls";

const WEB = { name: "web", address: ":8000", tls: false, redirectTo: null };

const promo = (
  annotations: Record<string, string> = {},
  className = "traefik"
): IngressInfo =>
  ({
    uid: "",
    name: "promo",
    namespace: "shop",
    className,
    rules: [
      {
        host: "promo.example.com",
        paths: [
          {
            path: "/",
            pathType: "Prefix",
            backendService: "promo",
            backendPort: "80",
            resourceBackend: null,
          },
        ],
      },
    ],
    loadBalancerIps: [],
    tlsHosts: ["promo.example.com"],
    tlsConfigs: [
      {
        hosts: ["promo.example.com"],
        secretName: "promo-tls",
        isCatchAll: false,
      },
    ],
    hasCatchAllTls: false,
    defaultBackend: null,
    labels: {},
    annotations,
    createdAt: null,
  }) as IngressInfo;

const ask = () =>
  ingressTls([
    { namespace: "shop", name: "promo", hosts: ["promo.example.com"] },
  ]);

const controllerWith = (entryPoints: (typeof WEB)[]) =>
  vi.mocked(fetchController).mockResolvedValue({
    workload: null,
    args: [],
    entryPoints,
    emptyServices: null,
    problem: null,
  } as never);

describe("what Traefik tells the Ingress pages about TLS", () => {
  beforeEach(() => controllerWith([WEB]));

  /**
   * The core pages read spec.tls as "over HTTPS" and offered https:// for a
   * Traefik router that answers plain HTTP on `web` and nothing on 443.
   */
  it("says a host spec.tls names is plain HTTP, replacing the field's answer", async () => {
    vi.mocked(commands.listIngresses).mockResolvedValue([promo()]);

    const [[answer]] = await ask();

    expect(answer).toMatchObject({
      host: "promo.example.com",
      terminated: false,
      replacesSpec: true,
      by: { key: "traefikTlsNotServed" },
    });
  });

  it("says TLS from the named Secret once the router asks for it", async () => {
    vi.mocked(commands.listIngresses).mockResolvedValue([
      promo({ "traefik.ingress.kubernetes.io/router.tls": "true" }),
    ]);

    const [[answer]] = await ask();

    expect(answer).toMatchObject({
      terminated: true,
      by: { key: "verbatimLine", values: { said: "promo-tls" } },
    });
  });

  /** Entry points nobody read leave the answer open, never "plain". */
  it("cannot tell while the entry points are unread", async () => {
    vi.mocked(commands.listIngresses).mockResolvedValue([promo()]);
    controllerWith([]);

    const [[answer]] = await ask();

    expect(answer.terminated).toBeNull();
  });

  /** Another controller's Ingress is not Traefik's to speak for. */
  it("says nothing about an Ingress Traefik does not claim", async () => {
    vi.mocked(commands.listIngresses).mockResolvedValue([promo({}, "nginx")]);

    expect(await ask()).toEqual([[]]);
  });
});
