import { describe, expect, it } from "vitest";

import { countReconcilers } from "./data";
import type { FluxPicture } from "./model";

const picture = (unread: FluxPicture["unread"]): FluxPicture => ({
  reconcilers: [],
  sources: [],
  unread,
});

describe("the sidebar's reconciler count", () => {
  /**
   * With HelmReleases refused the count is Kustomizations alone, and the row
   * said "0" beside a cluster full of releases while the page said the list
   * could not be read.
   */
  it("could not say when a reconciler kind was not listed", () => {
    expect(
      countReconcilers(
        picture([
          { kind: "HelmRelease", crd: "helmreleases", reason: "forbidden" },
        ])
      )
    ).toBeNull();
  });

  /** An unread source kind does not change how many reconcilers there are. */
  it("counts when only a source kind was not listed", () => {
    expect(
      countReconcilers(
        picture([{ kind: "Bucket", crd: "buckets", reason: "forbidden" }])
      )
    ).toBe(0);
  });
});
