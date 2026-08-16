import { describe, expect, it } from "vitest";

import type { CustomResourceDetailInfo } from "@/generated/types";
import { peekIngressRoute, peekMiddleware } from "./peek";

const resource = (
  spec: unknown,
  kind = "IngressRoute"
): CustomResourceDetailInfo =>
  ({
    name: "api-ingressroute",
    namespace: "backend",
    kind,
    apiVersion: "traefik.io/v1alpha1",
    spec,
    status: null,
    labels: {},
    annotations: {},
    createdAt: null,
    ownerReferences: [],
  }) as unknown as CustomResourceDetailInfo;

const rows = (
  summary: ReturnType<typeof peekIngressRoute>,
  title: string
): Array<[unknown, unknown]> =>
  (summary.groups.find((group) => group.title === title)?.items ?? []).map(
    (item) => [item.label, item.value]
  );

describe("what an IngressRoute peek says", () => {
  /**
   * The reported gap, against the reported object: everything anybody opens
   * the peek for — the rule, the priority, the services, the middlewares —
   * is in the spec, and the generic flattener showed "routes: 1 entries".
   */
  it("reads the whole route out of the spec", () => {
    const summary = peekIngressRoute(
      resource({
        entryPoints: ["web"],
        routes: [
          {
            kind: "Rule",
            match: "Host(`api.sketchar.io`, `api.sketchar.tech`)",
            middlewares: [{ name: "tech-to-host" }, { name: "compress" }],
            priority: 120,
            services: [{ name: "api", port: 8080 }],
          },
        ],
      })
    );

    expect(rows(summary, "Routing")).toContainEqual(["Entry points", "web"]);

    const route = rows(summary, "Route");
    expect(route).toContainEqual([
      "Match",
      "Host(`api.sketchar.io`, `api.sketchar.tech`)",
    ]);
    expect(route).toContainEqual([
      "Hosts",
      "api.sketchar.io · api.sketchar.tech",
    ]);
    expect(route).toContainEqual(["Priority", "120"]);
    expect(route).toContainEqual(["Service", "api :8080"]);
    expect(route).toContainEqual(["Middlewares", "tech-to-host · compress"]);
  });

  /** An unset priority is still an answer: Traefik's rule-length default. */
  it("states the defaulted priority rather than omitting it", () => {
    const match = "Host(`shop.example.com`)";
    const summary = peekIngressRoute(
      resource({
        routes: [{ match, services: [{ name: "web", port: 80 }] }],
      })
    );

    expect(rows(summary, "Route")).toContainEqual([
      "Priority",
      `${match.length} — the rule's length, Traefik's default`,
    ]);
  });

  /** `tls: {}` means the default certificate, not "no TLS". */
  it("reads the three spellings of TLS apart", () => {
    const bare = peekIngressRoute(resource({ routes: [] }));
    expect(rows(bare, "Routing")).toContainEqual([
      "TLS",
      "none declared — an entry point may still carry it",
    ]);

    const named = peekIngressRoute(
      resource({ routes: [], tls: { secretName: "wildcard-tls" } })
    );
    expect(rows(named, "Routing")).toContainEqual(["TLS", "wildcard-tls"]);

    const empty = peekIngressRoute(resource({ routes: [], tls: {} }));
    expect(rows(empty, "Routing")).toContainEqual([
      "TLS",
      "the proxy's default certificate",
    ]);
  });
});

describe("what a Middleware peek says", () => {
  it("names the type and its settings", () => {
    const summary = peekMiddleware(
      resource(
        { redirectRegex: { regex: "^https?://x/(.*)", replacement: "/$1" } },
        "Middleware"
      )
    );

    const items = rows(summary, "redirectRegex");
    expect(items).toContainEqual(["regex", "^https?://x/(.*)"]);
    expect(items).toContainEqual(["replacement", "/$1"]);
  });
});
