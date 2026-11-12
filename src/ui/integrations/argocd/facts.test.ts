import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const listCustomResources = vi.fn();
vi.mock("@/lib/commands", () => ({
  commands: {
    listCustomResources: (...args: unknown[]) => listCustomResources(...args),
  },
}));

const { facts } = await import("./facts");

const application = (
  name: string,
  spec: Record<string, unknown>,
  status: Record<string, unknown>
) => ({
  name,
  namespace: "argocd",
  spec,
  status,
  labels: {},
  annotations: {},
  ownerReferences: [],
});

beforeEach(() => listCustomResources.mockReset());

describe("Argo CD's row", () => {
  /**
   * The row counted drift only with auto-sync off, and said nothing of an
   * Application Argo never compared: three Applications, none in sync, and
   * a row that read "3 Applications". Fails if either goes uncounted.
   */
  it("counts what auto-sync left out of sync and what Argo has not compared", async () => {
    listCustomResources.mockResolvedValue([
      application(
        "left",
        { syncPolicy: { automated: {} } },
        { sync: { status: "OutOfSync" }, health: { status: "Healthy" } }
      ),
      application("new", {}, {}),
      application(
        "fine",
        {},
        { sync: { status: "Synced" }, health: { status: "Healthy" } }
      ),
    ]);

    const lines = await facts();

    expect(lines.map((line) => line.say)).toEqual([
      { key: "kindCount", values: { n: 3, kind: "Application" } },
      { key: "factDriftedUnfixed", values: { n: 1 } },
      { key: "factNotCompared", values: { n: 1 } },
      { key: "factShowThem" },
    ]);
  });
});
