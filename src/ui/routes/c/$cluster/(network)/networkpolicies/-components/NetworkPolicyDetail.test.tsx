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
  uid: "",
  name: "p",
  namespace: "shop",
  selects: { kind: "everything" },
  selected,
  nearly: null,
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

describe("why a NetworkPolicy's page says it restricts nothing", () => {
  const typo: NetworkPolicyInfo = {
    ...policy(0),
    name: "allow-demo",
    selects: { kind: "written", query: "app=cloud-dmeo" },
    nearly: { asked: "app=cloud-dmeo", carried: "app=cloud-demo", pods: 2 },
  };

  /**
   * A policy over a misspelled label said only "no pods", and the reader
   * compared labels by hand. Fails if the page stops leading with the cause
   * and the label its pods carry instead.
   */
  it("leads with the label its pods carry a typo away", async () => {
    await renderPolicy(typo, "overview");
    expect(
      screen.getByText("This policy restricts nothing")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "No pod in shop carries app=cloud-dmeo, and 2 pods carry app=cloud-demo, a character or two away. If that is the label meant, correct the selector."
      )
    ).toBeInTheDocument();
  });

  /** Fails if a selector no label is near loses its sentence with the typo. */
  it("names the selector no pod carries where no label is near", async () => {
    await renderPolicy({ ...typo, nearly: null }, "overview");
    expect(
      screen.getByText(
        "A NetworkPolicy acts only on the pods it selects, and no pod in shop carries app=cloud-dmeo."
      )
    ).toBeInTheDocument();
  });

  /**
   * A refused pod list is not a policy in front of nothing. Fails if "could
   * not look" is said as "restricts nothing".
   */
  it("says nothing of the kind where its pods could not be read", async () => {
    await renderPolicy({ ...typo, selected: null, nearly: null }, "overview");
    expect(screen.queryByText("This policy restricts nothing")).toBeNull();
    await renderPolicy({ ...typo, selected: 2, nearly: null }, "overview");
    expect(screen.queryByText("This policy restricts nothing")).toBeNull();
  });
});
