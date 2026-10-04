import { describe, expect, it, vi } from "vite-plus/test";
import { cleanup, screen } from "@testing-library/react";

vi.mock("@/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks")>()),
  useResourceDetail: vi.fn(),
}));

vi.mock("@/lib/commands", () => ({
  commands: new Proxy({}, { get: () => vi.fn(async () => null) }),
}));

import { useResourceDetail } from "@/hooks";
import type { NetworkPolicyInfo } from "@/generated/types";
import { renderWithRouter } from "@/test/render";
import { NetworkPolicyDetail } from "./NetworkPolicyDetail";

const policy = (selected: number | null): NetworkPolicyInfo => ({
  name: "p",
  namespace: "shop",
  selects: { kind: "everything" },
  selected,
  ingress: {
    governed: true,
    rules: [],
    opensToEverything: false,
    deniesEverything: true,
  },
  egress: {
    governed: false,
    rules: [],
    opensToEverything: false,
    deniesEverything: false,
  },
  labels: {},
  createdAt: null,
});

/** The colour the page paints the policy's pod reach in. */
async function reachColour(
  selected: number | null,
  words: string
): Promise<string> {
  cleanup();
  vi.mocked(useResourceDetail).mockReturnValue({
    name: "p",
    namespace: "shop",
    resource: policy(selected),
    isLoading: false,
    error: null,
    yaml: "",
    copyYaml: vi.fn(),
    activeTab: "overview",
    setActiveTab: vi.fn(),
    goBack: vi.fn(),
    refetch: vi.fn(),
    deleteMutation: { mutate: vi.fn(), isPending: false },
  } as unknown as ReturnType<typeof useResourceDetail>);
  await renderWithRouter(<NetworkPolicyDetail />, {
    at: "/c/prod/networkpolicies/shop/p",
    route: "/c/$cluster/networkpolicies/$namespace/$name",
  });
  const drawn = screen.getByText(words, { selector: "dd, dd *" });
  const painted = drawn.closest("[class*='text-']");
  return /text-(?:fg(?:-\w+)?|warn|err|ok|info)\b/.exec(
    painted?.className ?? ""
  )![0];
}

describe("the pods a NetworkPolicy's page says it selects", () => {
  /**
   * "pods not read" was drawn in the colour of a count, the words the only
   * difference between a refused pod list and one that was read.
   */
  it("paints a pod list it could not read apart from a count and from none", async () => {
    const refused = await reachColour(null, "pods not read");
    expect(refused).not.toBe(await reachColour(3, "3 pods"));
    expect(refused).not.toBe(await reachColour(0, "no pods"));
  });
});
