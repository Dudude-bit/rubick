import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/lib/commands", () => ({
  commands: {
    getCustomResource: vi.fn(),
    listIngresses: vi.fn(),
  },
}));

import { commands } from "@/lib/commands";
import { RelatedShort } from "../registry";
import { relatedTo } from "./related";

const SUBJECT = {
  group: "cert-manager.io",
  kind: "Certificate",
  namespace: "shop",
  name: "web",
};

beforeEach(() => {
  vi.mocked(commands.getCustomResource).mockResolvedValue({
    name: "web",
    namespace: "shop",
    spec: {
      secretName: "web-tls",
      issuerRef: { name: "ca" },
      dnsNames: ["shop.example.com"],
    },
  } as never);
});

describe("what a Certificate is connected to", () => {
  /**
   * The Ingresses came back through `.catch(() => [])`, so a refused list
   * drew a certificate that serves a hostname as serving nothing. Fails if
   * the failure is swallowed, or takes the Issuer and the Secret with it.
   */
  it("hands over the Issuer and the Secret with the failure when the Ingresses cannot be listed", async () => {
    const refused = new Error("ingresses is forbidden");
    vi.mocked(commands.listIngresses).mockRejectedValue(refused);

    const thrown = await relatedTo(SUBJECT).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(RelatedShort);
    const short = thrown as RelatedShort;
    expect(short.cause).toBe(refused);
    expect(short.related.map((row) => `${row.kind} ${row.name}`)).toEqual([
      "Issuer ca",
      "Secret web-tls",
    ]);
  });

  /** The other half: with the Ingresses read, the one that mounts the Secret is a row. */
  it("names the Ingress serving under its Secret once they are read", async () => {
    vi.mocked(commands.listIngresses).mockResolvedValue([
      {
        name: "storefront",
        namespace: "shop",
        rules: [{ host: "shop.example.com", paths: [] }],
        tlsConfigs: [
          {
            hosts: ["shop.example.com"],
            secretName: "web-tls",
            isCatchAll: false,
          },
        ],
      },
    ] as never);

    const related = await relatedTo(SUBJECT);

    expect(related?.map((row) => `${row.relation} ${row.name}`)).toEqual([
      "relIssuedBy ca",
      "relIssuesInto web-tls",
      "relServing storefront",
    ]);
  });
});
