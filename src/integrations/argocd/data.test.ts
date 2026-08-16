import { describe, expect, it } from "vitest";

import type { ServiceRoute } from "../registry";
import { uiAddress, uiFromRoutes } from "./data";
import type { IngressInfo } from "@/generated/types";

const route = (overrides: Partial<ServiceRoute> = {}): ServiceRoute => ({
  host: "argocd.example.com",
  path: "/",
  tls: true,
  source: { kind: "IngressRoute", name: "argocd", namespace: "argocd" },
  ...overrides,
});

describe("the address Argo's UI answers on", () => {
  it("builds a URL from a route whose scheme is settled", () => {
    expect(uiFromRoutes([route()]).url).toBe("https://argocd.example.com");
    expect(uiFromRoutes([route({ tls: false })]).url).toBe(
      "http://argocd.example.com"
    );
  });

  /** `/` is where the host already points; `/argo` is part of the address. */
  it("keeps a path that is not the root", () => {
    expect(uiFromRoutes([route({ path: "/argo" })]).url).toBe(
      "https://argocd.example.com/argo"
    );
  });

  /**
   * The state this whole three-valued `tls` exists for. The host is known
   * and the scheme is not, so the page names the host and offers no link —
   * guessing `https://` for something served in the clear would replace a
   * wrong sentence with a wrong link.
   */
  it("names the host but withholds the link when the scheme is unsettled", () => {
    const answer = uiFromRoutes([route({ tls: null })]);
    expect(answer.url).toBeNull();
    expect(answer.host).toBe("argocd.example.com");
    expect(answer.via?.name).toBe("argocd");
  });

  /** A host reachable both ways is one the reader should reach securely. */
  it("prefers a route that is served over TLS", () => {
    expect(
      uiFromRoutes([
        route({ tls: false, host: "plain.example.com" }),
        route({ tls: true, host: "secure.example.com" }),
      ]).url
    ).toBe("https://secure.example.com");
  });

  /** A settled scheme beats an unsettled one, so a link can be offered. */
  it("prefers a route it can link over one it cannot", () => {
    expect(
      uiFromRoutes([
        route({ tls: null, host: "unknown.example.com" }),
        route({ tls: false, host: "plain.example.com" }),
      ]).url
    ).toBe("http://plain.example.com");
  });

  it("has nothing to say about a Service nothing routes", () => {
    expect(uiFromRoutes([])).toEqual({ url: null, host: null, via: null });
  });
});

const serving = (overrides: Partial<IngressInfo>): IngressInfo => ({
  name: "argocd-server",
  namespace: "argocd",
  className: null,
  rules: [
    {
      host: "argocd.example.com",
      paths: [
        {
          path: "/",
          pathType: "Prefix",
          backendService: "argocd-server",
          backendPort: "80",
          resourceBackend: null,
        },
      ],
    },
  ],
  loadBalancerIps: [],
  tlsHosts: [],
  tlsConfigs: [],
  hasCatchAllTls: false,
  labels: {},
  annotations: {},
  createdAt: null,
  ...overrides,
});

describe("the scheme an Ingress is read as serving", () => {
  /**
   * The reported case: one Secret holding `*.example.com` and `example.com`,
   * which is what somebody sets up so they never think about it again.
   * Compared literally, this page handed the reader `http://` for a host that
   * only answers on 443 — and every surface reading the same way called it
   * served in the clear.
   */
  it("reads a wildcard entry as covering the host", () => {
    expect(
      uiAddress(
        [serving({ tlsHosts: ["*.example.com", "example.com"] })],
        "argocd"
      )
    ).toBe("https://argocd.example.com");

    expect(
      uiAddress(
        [
          serving({
            tlsConfigs: [
              {
                hosts: ["*.example.com"],
                secretName: "wildcard-tls",
                isCatchAll: false,
              },
            ],
          }),
        ],
        "argocd"
      )
    ).toBe("https://argocd.example.com");
  });

  /** A wildcard covers one label, so a name it does not reach stays plain. */
  it("does not stretch a wildcard past one label", () => {
    expect(
      uiAddress(
        [
          serving({
            rules: [
              {
                host: "a.argocd.example.com",
                paths: [
                  {
                    path: "/",
                    pathType: "Prefix",
                    backendService: "argocd-server",
                    backendPort: "80",
                    resourceBackend: null,
                  },
                ],
              },
            ],
            tlsHosts: ["*.example.com"],
          }),
        ],
        "argocd"
      )
    ).toBe("http://a.argocd.example.com");
  });
});
