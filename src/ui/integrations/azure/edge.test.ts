import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/lib/commands", () => ({
  commands: { listIngresses: vi.fn(), resolveIngressClass: vi.fn() },
}));

import { commands } from "@/lib/commands";
import { serviceEdge } from "./edge";

const ingress = (name: string, backend: string, className: string | null) => ({
  name,
  namespace: "web",
  className,
  annotations: { "appgw.ingress.kubernetes.io/request-timeout": "30" },
  rules: [{ host: "shop.example.com", paths: [{ backendService: backend }] }],
});

const ask = () => serviceEdge({ namespace: "web", name: "storefront" });

beforeEach(() => {
  vi.mocked(commands.resolveIngressClass).mockResolvedValue({
    available: [
      {
        name: "azure-application-gateway",
        controller: "azure/application-gateway",
        isDefault: false,
        parameters: null,
      },
    ],
  } as never);
});

describe("what an Application Gateway was told about a Service", () => {
  /**
   * The same test as the TLS reader's: an Ingress on the gateway through
   * `spec.ingressClassName` added nothing to its Service's chain. Fails if
   * the class in the field is not read by its controller here too.
   */
  it("reads the Ingress that names AGIC's class in spec.ingressClassName", async () => {
    vi.mocked(commands.listIngresses).mockResolvedValue([
      ingress("shop", "storefront", "azure-application-gateway"),
      ingress("other", "storefront", "nginx"),
    ] as never);

    const edges = await ask();
    expect(edges.map((edge) => edge.source.name)).toEqual(["shop"]);
    expect(edges[0].summary).toEqual([
      { key: "agicRequestTimeout", values: { n: 30 } },
    ]);
  });

  /**
   * With the IngressClass list refused, an empty answer says no gateway
   * configures this Service. Fails if the unread list is read as "not
   * AGIC's", or an Ingress routing elsewhere fails this Service's answer.
   */
  it("does not answer for an Ingress whose class could not be resolved", async () => {
    const refused = new Error("ingressclasses is forbidden");
    vi.mocked(commands.resolveIngressClass).mockRejectedValue(refused);
    vi.mocked(commands.listIngresses).mockResolvedValue([
      ingress("other", "billing", "azure-application-gateway"),
    ] as never);
    await expect(ask()).resolves.toEqual([]);

    vi.mocked(commands.listIngresses).mockResolvedValue([
      ingress("shop", "storefront", "azure-application-gateway"),
    ] as never);
    await expect(ask()).rejects.toBe(refused);
  });
});
