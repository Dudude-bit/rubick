import { describe, expect, it, vi } from "vitest";

import type { CustomResourceInfo } from "@/generated/types";

const listed = vi.hoisted(() => vi.fn());
vi.mock("@/lib/commands", () => ({
  commands: { listCustomResources: listed },
}));

const { facts } = await import("./facts");

function policy(name: string, status: unknown): CustomResourceInfo {
  return {
    name,
    namespace: "shop",
    kind: "CiliumNetworkPolicy",
    spec: {},
    status,
  } as CustomResourceInfo;
}

const VALID = { conditions: [{ type: "Valid", status: "True" }] };
const REJECTED = {
  conditions: [
    { type: "Valid", status: "False", message: "invalid label selector" },
  ],
};

function answers(
  policies: CustomResourceInfo[],
  clusterwide: CustomResourceInfo[] = []
) {
  listed.mockReset();
  listed.mockImplementation((kind: string) =>
    Promise.resolve(
      kind.startsWith("ciliumclusterwide") ? clusterwide : policies
    )
  );
}

describe("the Cilium row", () => {
  /**
   * The finding the row exists for. A rejected policy sits in every list
   * beside the ones that work, and the namespace it was meant to close is
   * open. Fails if it stops being counted or stops being red.
   */
  it("says how many policies the agent threw away, in the failure tone", async () => {
    answers([policy("ok", VALID), policy("typo", REJECTED)]);

    const lines = await facts();
    const rejected = lines.find((line) =>
      JSON.stringify(line.say).includes("factCiliumRejected")
    );
    expect(rejected).toBeDefined();
    expect(rejected?.tone).toBe("err");
    expect(JSON.stringify(rejected?.say)).toContain('"n":1');
  });

  /**
   * Silence is its own line, and a quieter one: a policy written a second
   * ago and a policy the agent is not running look the same, and neither is
   * a rejection. Fails if the two findings are merged.
   */
  it("reports policies nobody has answered about apart from rejected ones", async () => {
    answers([policy("fresh", null)]);

    const lines = await facts();
    const said = JSON.stringify(lines);
    expect(said).toContain("factCiliumUnanswered");
    expect(said).not.toContain("factCiliumRejected");
    expect(
      lines.find((line) => JSON.stringify(line.say).includes("Unanswered"))
        ?.tone
    ).toBe("warn");
  });

  /** Nothing to report is not a finding: a clean cluster gets counts only. */
  it("adds no finding when every policy is in force", async () => {
    answers([policy("ok", VALID)], [policy("wide", VALID)]);

    const lines = await facts();
    expect(lines).toHaveLength(1);
    expect(JSON.stringify(lines)).toContain("factCiliumClusterwide");
  });
});
