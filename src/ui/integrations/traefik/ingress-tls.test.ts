import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { IngressInfo } from "@/generated/types";

vi.mock("@/lib/commands", () => ({
  commands: {
    listIngresses: vi.fn(async () => []),
    listIngressesIn: vi.fn(),
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

  /**
   * An answer that has not come cannot say it replaces spec.tls, so the
   * supplier says it ahead of one. Fails if the declaration is dropped while
   * the answers still carry the flag: a pending read then leaves spec.tls
   * standing as HTTPS.
   */
  it("declares ahead of any answer that its word replaces spec.tls", () => {
    expect(ingressTls.replacesSpec).toBe(true);
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

  const REFUSED = {
    code: "PERMISSION_DENIED",
    message: "ingresses.networking.k8s.io is forbidden",
  };

  /**
   * Bound to their namespaces, a reader was refused the cluster's Ingress
   * list and every `spec.tls` host read "TLS not checked" for good, though
   * the Ingress asked about was theirs to read. Fails if a refusal of the
   * cluster's list is the end of it, or if any other failure is read around.
   */
  it("reads the namespaces it was asked about where the cluster's list is refused", async () => {
    vi.mocked(commands.listIngresses).mockRejectedValue(REFUSED);
    vi.mocked(commands.listIngressesIn).mockResolvedValue({
      rows: [promo()],
      unread: [],
    });

    const [[answer]] = await ask();

    expect(commands.listIngressesIn).toHaveBeenCalledWith(["shop"]);
    expect(answer).toMatchObject({ terminated: false, replacesSpec: true });

    vi.mocked(commands.listIngresses).mockRejectedValue(new Error("timeout"));
    await expect(ask()).rejects.toThrow("timeout");
  });

  /**
   * A namespace that refuses too leaves its hosts unknown in the cluster's
   * words. Fails if they are dropped, which hands `spec.tls` the answer.
   */
  it("leaves a host unknown, with the cluster's words, where its namespace is refused too", async () => {
    vi.mocked(commands.listIngresses).mockRejectedValue(REFUSED);
    vi.mocked(commands.listIngressesIn).mockResolvedValue({
      rows: [],
      unread: [{ namespace: "shop", code: "", message: REFUSED.message }],
    });

    expect(await ask()).toEqual([
      [
        {
          host: "promo.example.com",
          terminated: null,
          by: { key: "verbatimLine", values: { said: REFUSED.message } },
          replacesSpec: true,
        },
      ],
    ]);
  });

  /** Another controller's Ingress is not Traefik's to speak for. */
  it("says nothing about an Ingress Traefik does not claim", async () => {
    vi.mocked(commands.listIngresses).mockResolvedValue([promo({}, "nginx")]);

    expect(await ask()).toEqual([[]]);
  });
});
