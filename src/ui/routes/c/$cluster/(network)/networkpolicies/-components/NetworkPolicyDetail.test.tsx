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

async function renderPolicy(info: NetworkPolicyInfo, tab: string) {
  cleanup();
  vi.mocked(useResourceDetail).mockReturnValue({
    name: info.name,
    namespace: info.namespace,
    resource: info,
    isLoading: false,
    error: null,
    yaml: "",
    copyYaml: vi.fn(),
    activeTab: tab,
    setActiveTab: vi.fn(),
    goBack: vi.fn(),
    refetch: vi.fn(),
    deleteMutation: { mutate: vi.fn(), isPending: false },
  } as unknown as ReturnType<typeof useResourceDetail>);
  await renderWithRouter(<NetworkPolicyDetail />, {
    at: `/c/prod/networkpolicies/${info.namespace}/${info.name}`,
    route: "/c/$cluster/networkpolicies/$namespace/$name",
  });
}

describe("what a NetworkPolicy's page resolves", () => {
  /**
   * "Pods 2 pods" was plain text, and the reader matched app=api to pods by
   * hand. Fails if the count stops opening the Pods list narrowed to them.
   */
  it("links the pods it selects to the Pods list narrowed to its selector", async () => {
    await renderPolicy(
      {
        ...policy(2),
        name: "api-from-frontend",
        namespace: "net",
        selects: { kind: "written", query: "app=api" },
      },
      "overview"
    );
    const link = screen.getByRole("link", { name: "2 pods" });
    const href = decodeURIComponent(link.getAttribute("href") ?? "");
    expect(href).toContain("/c/prod/pods");
    expect(href).toContain("selector=app=api");
    expect(href).toContain("in=net");
  });

  /**
   * "Egress: says nothing" read as unknown. A direction policyTypes leaves
   * out is one this policy does not restrict, and the page says so.
   */
  it("says which direction it does not restrict and why", async () => {
    await renderPolicy(policy(2), "rules");
    expect(
      screen.getByText(
        "Does not restrict Egress: policyTypes names Ingress only."
      )
    ).toBeInTheDocument();
  });
});
