import { beforeEach, describe, expect, it, vi } from "vitest";

const { listCustomResources } = vi.hoisted(() => ({
  listCustomResources: vi.fn(),
}));
vi.mock("@/lib/commands", () => ({ commands: { listCustomResources } }));

import { HELM_RELEASES_CRD } from "./data";
import { relatedTo } from "./related";

const release = {
  group: "helm.toolkit.fluxcd.io",
  kind: "HelmRelease",
  namespace: "flux-system",
  name: "podinfo",
};

beforeEach(() => {
  listCustomResources.mockReset();
});

describe("what a HelmRelease is connected to", () => {
  /**
   * `[]` is "looked and found nothing". A refused `helmreleases` list said it
   * about a release that is there, so its Connections tab went blank.
   */
  it("fails rather than answer nothing when HelmReleases could not be listed", async () => {
    listCustomResources.mockImplementation(async (crd: string) => {
      if (crd === HELM_RELEASES_CRD) {
        throw new Error("helmreleases.helm.toolkit.fluxcd.io is forbidden", {
          cause: { code: "PERMISSION_DENIED", message: "forbidden" },
        });
      }
      return [];
    });
    await expect(relatedTo(release)).rejects.toThrow(/forbidden/);
  });

  /** Read and absent is the real "nothing". */
  it("answers nothing when the list was read and it is not in it", async () => {
    listCustomResources.mockResolvedValue([]);
    await expect(relatedTo(release)).resolves.toEqual([]);
  });
});
