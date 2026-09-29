import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { findingDetail } from "./finding-words";
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
