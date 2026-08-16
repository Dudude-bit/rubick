/**
 * AGIC keeps its certificate on the Application Gateway and names it in an
 * annotation, and the docs are explicit that the annotation is ignored when
 * `spec.tls` is present — so the two are alternatives, and the annotation-only
 * shape is the ordinary one. Read through `spec.tls` alone it was plain HTTP.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/commands", () => ({
  commands: { getIngress: vi.fn() },
}));

import { commands } from "@/lib/commands";
import { ingressTls } from "./ingress-tls";

const ingress = (annotations: Record<string, string>) =>
  ({
    name: "shop",
    namespace: "web",
    className: null,
    annotations: {
      "kubernetes.io/ingress.class": "azure/application-gateway",
      ...annotations,
    },
  }) as never;

const ask = () => [
  { namespace: "web", name: "shop", hosts: ["shop.example.com"] },
];

describe("whether an AGIC Ingress serves TLS", () => {
  it("names the certificate installed on the gateway", async () => {
    vi.mocked(commands.getIngress).mockResolvedValue(
      ingress({
        "appgw.ingress.kubernetes.io/appgw-ssl-certificate": "wildcard-2026",
      })
    );

    const [answers] = await ingressTls(ask());
    expect(answers[0].terminated).toBe(true);
    expect(answers[0].by).toContain("wildcard-2026");
  });

  /** A redirect is only ever built beside a listener to redirect to. */
  it("takes an ssl-redirect as evidence of a listener", async () => {
    vi.mocked(commands.getIngress).mockResolvedValue(
      ingress({ "appgw.ingress.kubernetes.io/ssl-redirect": "true" })
    );
    const [answers] = await ingressTls(ask());
    expect(answers[0].terminated).toBe(true);
  });

  it("says nothing about an Ingress AGIC does not claim", async () => {
    vi.mocked(commands.getIngress).mockResolvedValue({
      name: "shop",
      namespace: "web",
      className: "nginx",
      annotations: {
        "appgw.ingress.kubernetes.io/appgw-ssl-certificate": "wildcard-2026",
      },
    } as never);
    await expect(ingressTls(ask())).resolves.toEqual([[]]);
  });
});
