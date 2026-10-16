import { describe, expect, it, vi } from "vite-plus/test";

const { listCustomResources } = vi.hoisted(() => ({
  listCustomResources: vi.fn(),
}));
vi.mock("@/lib/commands", () => ({ commands: { listCustomResources } }));

import type { ServiceRoute } from "../registry";
import {
  fetchApplicationSets,
  uiFromFront,
  uiFromRoutes,
  uiFront,
} from "./data";
import type { IngressInfo } from "@/generated/types";

const failing = (code: string, words: string) =>
  new Error(`Tauri command 'listCustomResources' failed: ${words}`, {
    cause: { code, message: words },
  });

describe("reading ApplicationSets", () => {
  /**
   * A refused list came back as `[]`, and the tab told the reader every
   * Application here was written by hand.
   */
  it("keeps a refusal as a failed read, not as none", async () => {
    listCustomResources.mockRejectedValueOnce(
      failing("PERMISSION_DENIED", "applicationsets.argoproj.io is forbidden")
    );
    await expect(fetchApplicationSets()).rejects.toThrow(/forbidden/);
  });

  /** An install without the ApplicationSet controller serves no such kind. */
  it("reads a kind the cluster does not serve as none", async () => {
    listCustomResources.mockRejectedValueOnce(
      failing("NOT_FOUND", "applicationsets.argoproj.io not found")
    );
    await expect(fetchApplicationSets()).resolves.toEqual([]);
  });
});

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

  /**
   * The gRPC way in serves the same Service and no browser: Argo's CLI
   * ingress pins `scheme: h2c`, and a link into it answers a browser with
   * nothing. It is the UI's address only when there is no other.
   */
  it("prefers the browser route over the h2c one", () => {
    expect(
      uiFromRoutes([
        route({ host: "argocd-grpc.example.com", h2c: true }),
        route({ host: "argocd.example.com" }),
      ]).url
    ).toBe("https://argocd.example.com");
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
  uid: "",
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
  defaultBackend: null,
  labels: {},
  annotations: {},
  createdAt: null,
  ...overrides,
});

/** The address `spec.tls` alone gives, before any controller has spoken. */
const uiAddress = (ingresses: IngressInfo[], namespace: string) => {
  const front = uiFront(ingresses, namespace);
  return front && uiFromFront(front, front.spec).url;
};

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

describe("the UI address once the Ingress's controller has spoken", () => {
  const front = uiFront(
    [serving({ tlsHosts: ["argocd.example.com"] })],
    "argocd"
  )!;

  /**
   * Traefik serves a host spec.tls names as plain HTTP unless the router asks
   * for TLS, and every Application's "open in Argo CD" link went to https://.
   */
  it("follows the controller's scheme over spec.tls", () => {
    expect(front.spec).toBe(true);
    expect(uiFromFront(front, false).url).toBe("http://argocd.example.com");
  });

  /** A scheme nobody settled names the host and links nothing. */
  it("withholds the link and keeps the host where nobody could tell", () => {
    expect(uiFromFront(front, null)).toEqual({
      url: null,
      host: "argocd.example.com",
      via: { kind: "Ingress", name: front.via.name, namespace: "argocd" },
    });
  });
});
