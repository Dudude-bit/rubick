/**
 * The Routes and Entry points tabs draw their own tables rather than
 * `page-kit`'s `TroubleList`, so nothing wires them into Share automatically.
 * Delete `routesTableSection` or `entryPointsSection`, or their
 * `useShareSection` calls in `page.tsx`, and these fail.
 */

import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { ControllerInfo } from "./data";
import type { HostGroup, TraefikRoute } from "./model";
import { entryPointsSection, routesTableSection } from "./share";

const t = ((
  section: never,
  key: never,
  values?: Record<string, string | number>
) => translate("en", section, key, values)) as never;

function route(overrides: Partial<TraefikRoute> = {}): TraefikRoute {
  return {
    key: "web/shop/0",
    source: { kind: "Ingress", name: "shop", namespace: "web" },
    rule: { raw: "Host(`shop.example.com`)" },
    clause: { host: "shop.example.com", path: null },
    entryPoints: ["websecure"],
    middlewares: [{ name: "strip-prefix", namespace: "web" }],
    service: {
      name: "storefront",
      namespace: "web",
      port: "80",
      isService: true,
    },
    resourceBackend: null,
    tlsSecret: "shop-tls",
    declaresTls: true,
    pathType: "Prefix",
    priority: null,
    ...overrides,
  } as unknown as TraefikRoute;
}

function group(overrides: Partial<HostGroup> = {}): HostGroup {
  return {
    host: "shop.example.com",
    routes: [route()],
    findings: [],
    chainFor: route(),
    tlsSecrets: [{ namespace: "web", secretName: "shop-tls" }],
    worst: null,
    backendsKnown: true,
    ...overrides,
  } as unknown as HostGroup;
}

describe("the routes table registers every router with Share", () => {
  it("carries the rule, entry points, middlewares, TLS secret and backend ref for each router", () => {
    const section = routesTableSection([group()], t);
    expect(section.body.type).toBe("table");
    if (section.body.type !== "table") throw new Error("expected a table");
    expect(section.body.rows).toHaveLength(1);
    const [cells] = section.body.rows.map((row) => row.cells);
    expect(cells[0]).toMatchObject({ text: "shop.example.com", role: "ok" });
    expect(cells[1].text).toBe("Host(`shop.example.com`)");
    expect(cells[2].text).toBe("websecure");
    expect(cells[3].text).toBe("strip-prefix");
    expect(cells[4].text).toBe("shop-tls");
    expect(cells[5]).toMatchObject({ text: "storefront" });
    expect(cells[5].ref?.kind).toBe("Service");
  });

  it("colours a row by the host's own worst finding, not a fixed tone", () => {
    const broken = group({ host: "broken.example.com", worst: "err" });
    const section = routesTableSection([broken], t);
    if (section.body.type !== "table") throw new Error("expected a table");
    expect(section.body.rows[0].cells[0].role).toBe("err");
  });

  it("names the backend by the object it actually lands on when there is no Service", () => {
    const section = routesTableSection(
      [
        group({
          routes: [
            route({ service: null, resourceBackend: "APIGroup/gateway" }),
          ],
        }),
      ],
      t
    );
    if (section.body.type !== "table") throw new Error("expected a table");
    expect(section.body.rows[0].cells[5]).toMatchObject({
      text: "APIGroup/gateway",
    });
  });
});

describe("the entry points table registers itself with Share", () => {
  const controller = (
    entryPoints: ControllerInfo["entryPoints"]
  ): ControllerInfo =>
    ({
      entryPoints,
      args: [],
      workload: null,
      problem: null,
    }) as unknown as ControllerInfo;

  it("says which entry points are plain and how many hosts land on each", () => {
    const section = entryPointsSection(
      controller([
        { name: "web", address: ":80", tls: false, redirectTo: null },
        { name: "websecure", address: ":443", tls: true, redirectTo: null },
      ]),
      [group()],
      t
    );
    expect(section).not.toBeNull();
    if (section === null || section.body.type !== "table")
      throw new Error("expected a table");
    expect(section.body.rows).toHaveLength(2);
    expect(section.body.rows[0].cells[2]).toMatchObject({ role: "warn" });
    expect(section.body.rows[1].cells[2]).toMatchObject({ role: "ok" });
  });

  it("reports nothing when the proxy's own entry points could not be read", () => {
    expect(entryPointsSection(undefined, [], t)).toBeNull();
    expect(entryPointsSection(controller([]), [], t)).toBeNull();
  });
});
