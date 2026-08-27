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

  /**
   * A conditions array is the one shape the whole API machinery shares, so
   * it is read as conditions: one row per verdict, coloured with the same
   * polarity every condition row in the app uses — not six grey fragments
   * per entry.
   */
  it("reads a conditions array as verdicts, one toned row each", () => {
    const rows = flatten(
      {
        conditions: [
          {
            type: "Accepted",
            status: "True",
            reason: "Accepted",
            message: "",
            lastTransitionTime: "2026-08-19T20:00:00Z",
          },
          {
            type: "Programmed",
            status: "False",
            reason: "Invalid",
            message: "listener not found",
          },
        ],
      },
      12
    );

    expect(rows).toContainEqual({
      label: "conditions.Accepted",
      value: "True",
      mono: true,
      tone: "ok",
    });
    expect(rows).toContainEqual({
      label: "conditions.Programmed",
      value: "False — Invalid: listener not found",
      mono: true,
      tone: "err",
    });
  });

  /** Negative-polarity conditions keep their meaning: pressure off is green. */
  it("does not paint a healthy negative condition red", () => {
    const rows = flatten(
      { conditions: [{ type: "MemoryPressure", status: "False" }] },
      12
    );
    expect(rows).toContainEqual({
      label: "conditions.MemoryPressure",
      value: "False",
      mono: true,
      tone: "ok",
    });
  });

  /** An array under the name that is not condition-shaped stays generic. */
  it("leaves a non-condition 'conditions' array to the generic walk", () => {
    const rows = flatten({ conditions: [{ match: "x" }] }, 12);
    expect(rows).toContainEqual({
      label: "conditions.0.match",
      value: "x",
      mono: true,
    });
  });
});
