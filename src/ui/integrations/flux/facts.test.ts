import { beforeEach, describe, expect, it, vi } from "vitest";

const answers = vi.hoisted(() => ({
  releases: (): Promise<unknown[]> => Promise.resolve([]),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    listCustomResources: (crd: string) => {
      if (crd === "kustomizations.kustomize.toolkit.fluxcd.io")
        return Promise.resolve([]);
      if (crd === "helmreleases.helm.toolkit.fluxcd.io")
        return answers.releases();
      return Promise.reject(
        new Error("not found", { cause: { code: "NOT_FOUND", message: "" } })
      );
    },
  },
}));

const { facts } = await import("./facts");

beforeEach(() => {
  answers.releases = () => Promise.resolve([]);
});

describe("Flux's row", () => {
  /**
   * The page's header called the count partial with HelmReleases refused,
   * and the row beside it said "0 reconcilers" with no way into the page.
   * Fails if the row counts an unread kind as none again.
   */
  it("counts only the reconcilers it read when HelmReleases were refused", async () => {
    answers.releases = () =>
      Promise.reject(
        new Error("helmreleases is forbidden", {
          cause: { code: "PERMISSION_DENIED", message: "forbidden" },
        })
      );

    const lines = await facts();

    expect(lines[0].say).toMatchObject({ key: "factReconcilersRead" });
    expect(lines.some((line) => line.to !== undefined)).toBe(true);
  });

  /** Every kind read and none there is a real zero, with nothing to open. */
  it("counts the reconcilers when every kind was read", async () => {
    const lines = await facts();

    expect(lines[0].say).toMatchObject({
      key: "factReconcilers",
      values: { n: 0 },
    });
    expect(lines.some((line) => line.to !== undefined)).toBe(false);
  });
});
