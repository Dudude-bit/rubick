import { describe, expect, it } from "vite-plus/test";

import { objectFacets } from "./facets";

/** The key itself, so a group is found by the catalogue key it is titled with. */
const t = ((_section: string, key: string) => key) as never;

const group = (object: unknown, title: string) =>
  objectFacets(object, t).groups.find((g) => g.title === title);

describe("what any object says about itself", () => {
  /** A manager that wrote twice is one writer, as of its latest write. */
  it("names each writer once, with its latest write", () => {
    const writers = group(
      {
        metadata: {
          managedFields: [
            {
              manager: "helm",
              operation: "Update",
              time: "2026-10-01T00:00:00Z",
            },
            {
              manager: "helm",
              operation: "Apply",
              time: "2026-10-03T00:00:00Z",
            },
            {
              manager: "kubectl",
              operation: "Update",
              time: "2026-10-02T00:00:00Z",
            },
          ],
        },
      },
      "writtenBy"
    );
    expect(writers?.items.map((item) => item.label)).toEqual([
      "helm",
      "kubectl",
    ]);
    expect(String(writers?.items[0].value)).toMatch(/^Apply/);
  });

  /** An object nobody wrote fields of has no writers group, not an empty one. */
  it("leaves out the writers of an object with no managed fields", () => {
    expect(group({ metadata: {} }, "writtenBy")).toBeUndefined();
  });

  /** The badge reads a Ready condition when no phase or state was given. */
  it("takes its state from a Ready condition", () => {
    const summary = objectFacets(
      { status: { conditions: [{ type: "Ready", status: "False" }] } },
      t
    );
    expect(summary.status).toBe("Not ready");
  });
});
