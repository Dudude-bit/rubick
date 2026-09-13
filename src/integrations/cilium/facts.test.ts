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
   * `IntegrationsCatalog` draws a fact carrying a `to` as a plain blue link
   * and drops its tone, so a finding that also carried a link came out blue
   * — the finding this whole vendor exists for. The way in is its own line,
   * the shape Istio and Traefik already use. Fails if a toned line grows a
   * `to` again.
   */
  it("never hangs a link on a line that carries a tone", async () => {
    answers([policy("typo", REJECTED), policy("fresh", null)]);

    for (const line of await facts()) {
      expect(line.tone && line.to).toBeFalsy();
    }
  });

  /**
   * A cluster can have both, and reporting only the louder one hides the
   * quieter. Fails if either finding starts suppressing the other.
   */
  it("reports a rejected policy and an unanswered one together", async () => {
    answers([policy("typo", REJECTED), policy("fresh", null)]);

    const said = JSON.stringify(await facts());
    expect(said).toContain("factCiliumRejected");
    expect(said).toContain("factCiliumUnanswered");
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

  /** Nothing to report is not a finding: a clean cluster gets counts and a way in. */
  it("adds no finding when every policy was accepted", async () => {
    answers([policy("ok", VALID)], [policy("wide", VALID)]);

    const lines = await facts();
    expect(JSON.stringify(lines)).toContain("factCiliumClusterwide");
    expect(lines.some((line) => line.tone)).toBe(false);
    expect(lines.at(-1)?.to).toBeDefined();
  });
});
