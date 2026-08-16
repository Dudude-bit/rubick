import { describe, expect, it } from "vitest";

import { flatten } from "./peek-sources";

describe("what a peek shows of a spec it has no schema for", () => {
  /**
   * The reported case: an IngressRoute's whole point — the match rule, the
   * service, the priority — sits inside `spec.routes`, and the peek printed
   * `routes: 1 entries` and nothing else. An array of objects is descended
   * with indexed paths, not counted.
   */
  it("descends into an array of objects instead of counting it", () => {
    const rows = flatten(
      {
        entryPoints: ["web", "websecure"],
        routes: [
          {
            match: "Host(`api.example.com`)",
            priority: 10,
            services: [{ name: "api", port: 8080 }],
          },
        ],
      },
      12
    );

    expect(rows).toContainEqual({
      label: "routes.0.match",
      value: "Host(`api.example.com`)",
      mono: true,
    });
    expect(rows).toContainEqual({
      label: "routes.0.priority",
      value: "10",
      mono: true,
    });
    expect(rows).toContainEqual({
      label: "routes.0.services.0.name",
      value: "api",
      mono: true,
    });
  });

  /** A scalar list stays one row — `web · websecure` reads, ten rows do not. */
  it("keeps a scalar array joined on one row", () => {
    const rows = flatten({ entryPoints: ["web", "websecure"] }, 12);
    expect(rows).toEqual([
      { label: "entryPoints", value: "web · websecure", mono: true },
    ]);
  });

  /** The cap still holds however deep the spec goes. */
  it("stops at the row limit", () => {
    const rows = flatten(
      { routes: Array.from({ length: 40 }, () => ({ match: "x" })) },
      12
    );
    expect(rows).toHaveLength(12);
  });
});
