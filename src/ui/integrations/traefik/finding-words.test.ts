import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { describeFinding, findingDetail } from "./finding-words";
import type { Finding, TraefikRoute } from "./model";

const t: T = (section, key, values) => translate("en", section, key, values);

const route = (name: string, priority: number | null = null) =>
  ({
    source: { kind: "IngressRoute", name, namespace: "shop" },
    priority,
  }) as unknown as TraefikRoute;

describe("a Traefik finding in a shared file", () => {
  /**
   * The page names the two objects claiming a path and which one wins; the
   * file said "Two objects claim /api" and stopped, which is the half of
   * the finding nobody can act on.
   */
  it("names the objects a finding is about, and what the page says of them", () => {
    const detail = findingDetail(
      {
        kind: "duplicate",
        severity: "warn",
        path: "/api",
        routes: [route("api-v1"), route("api-v2", 10)],
        winner: route("api-v2", 10),
        tied: false,
      } as unknown as Finding,
      t
    );
    expect(detail).toContain("IngressRoute shop/api-v2");
    expect(detail).toContain("10");
  });

  /** "Served in clear" without the entry points is a finding with no place to look. */
  it("names the entry points a host is served in clear on", () => {
    const detail = findingDetail(
      {
        kind: "clear",
        severity: "warn",
        entryPoints: ["web"],
      } as unknown as Finding,
      t
    );
    expect(detail).toContain("web");
  });
});

describe("a Traefik finding on the page", () => {
  /**
   * The stop's words were lowercased after the colon, which turned "Pod
   * Security" into "pod Security" and would turn ResourceQuota into
   * resourceQuota, a kind the reader then cannot find in their terminal.
   */
  it("keeps the case of a refusal's first word after the colon", () => {
    const said = describeFinding(
      {
        kind: "stop",
        severity: "err",
        route: route("web"),
        stop: {
          reason: "podsRefused",
          service: {
            kind: "Service",
            name: "web",
            namespace: "shop",
            existence: "present",
            facts: null,
          },
          selector: "app=web",
          workloads: [],
          said: 'pods "web-1" is forbidden: exceeded quota: two-pods, requested: pods=1, used: pods=2, limited: pods=2',
        },
        answer: "dropped",
      } as unknown as Finding,
      t
    );
    expect(said.title).toContain(
      "matches it: ResourceQuota two-pods refuses its pods"
    );
  });

  /**
   * Every stopped route read "every request gets a 502", a status Traefik
   * never answers for it: it drops the router, or answers 503 where
   * allowEmptyServices keeps it. Fails if any answer names a 502 again or
   * the three stop being told apart.
   */
  it("says what Traefik answers for a stopped route, and when it cannot tell", () => {
    const title = (answer: string) =>
      describeFinding(
        {
          kind: "stop",
          severity: "err",
          route: route("web"),
          stop: {
            reason: "selectsNothing",
            service: { kind: "Service", name: "web", namespace: "shop" },
            selector: "app=web",
            near: null,
            makersRead: true,
          },
          answer,
        } as unknown as Finding,
        t
      ).title;
    expect(title("dropped")).toBe(
      "Traefik drops this route, so a request gets a 404, or goes to whichever other route matches it: No pod carries app=web"
    );
    expect(title("unavailable")).toBe(
      "This host answers, and every request gets a 503: No pod carries app=web"
    );
    expect(title("unknown")).toContain(
      "depending on allowEmptyServices, which could not be read"
    );
  });
});
