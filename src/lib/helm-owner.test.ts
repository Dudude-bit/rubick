import { describe, expect, it } from "vitest";

import { helmOwnerOf, helmReleasePath } from "./helm-owner";

describe("the release an object says installed it", () => {
  /**
   * The way back from a Deployment to its release. It existed in the data all
   * along — Helm writes the annotation onto everything it applies — and was
   * read only by the Changes tab, so a release's Resources list was a one-way
   * door.
   */
  it("reads the release off the object's own annotations", () => {
    expect(
      helmOwnerOf({
        namespace: "shop",
        annotations: { "meta.helm.sh/release-name": "api" },
      })
    ).toEqual({ name: "api", namespace: "shop" });
  });

  /**
   * A release installs across namespaces, so where the release lives is its
   * own annotation and not the object's. Falling back to the object's
   * namespace would send the reader to a page that is not there.
   */
  it("believes the release's own namespace over the object's", () => {
    expect(
      helmOwnerOf({
        namespace: "shop",
        annotations: {
          "meta.helm.sh/release-name": "api",
          "meta.helm.sh/release-namespace": "platform",
        },
      })
    ).toEqual({ name: "api", namespace: "platform" });
  });

  /** Nothing to say is nothing drawn: an object nobody installed with Helm. */
  it("says nothing for an object with no release annotation", () => {
    expect(helmOwnerOf({ namespace: "shop", annotations: {} })).toBeNull();
    expect(helmOwnerOf({ namespace: "shop" })).toBeNull();
    expect(helmOwnerOf(undefined)).toBeNull();
    expect(helmOwnerOf(null)).toBeNull();
  });

  it("points at the release read from the cluster, which is always there", () => {
    expect(helmReleasePath({ name: "api", namespace: "platform" })).toBe(
      "/helm/native/platform/api"
    );
  });
});
