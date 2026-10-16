import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";

vi.mock("@/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks")>()),
  useResourceDetail: vi.fn(),
}));

/** Commands a test answers itself; every other one answers null. */
const answers = vi.hoisted(
  () => ({}) as Record<string, (...args: unknown[]) => Promise<unknown>>
);

vi.mock("@/lib/commands", () => ({
  commands: new Proxy(
    {},
    {
      get: (_, name: string) => answers[name] ?? vi.fn(async () => null),
    }
  ),
}));

import { useResourceDetail } from "@/hooks";
import type { ConditionInfo, GatewayInfo } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";
import { GatewayDetail } from "./GatewayDetail";

const said = (type: string, status: string, reason: string): ConditionInfo => ({
  type,
  status,
  reason,
  message: null,
  lastTransitionTime: null,
});

const edge = (listener: ConditionInfo[]): GatewayInfo => ({
  uid: "",
  name: "edge",
  namespace: "infra",
  apiVersion: "gateway.networking.k8s.io/v1",
  className: "istio",
  listenerSets: [],
  listenerSetsKnown: true,
  listeners: [
    {
      name: "https",
      port: 443,
      protocol: "HTTPS",
      hostname: null,
      tlsMode: null,
      certificateRefs: [],
      allowedNamespaces: null,
      attachedRoutes: 1,
      conditions: listener,
      fromListenerSet: null,
    },
  ],
  addresses: [],
  conditions: [said("Programmed", "True", "Programmed")],
  generation: 1,
  labels: {},
  annotations: {},
  createdAt: null,
});

const open = async (gateway: GatewayInfo) => {
  vi.mocked(useResourceDetail).mockReturnValue({
    name: "edge",
    namespace: "infra",
    resource: gateway,
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
  await renderWithRouter(<GatewayDetail />, {
    at: "/c/prod/gateways/infra/edge",
    route: "/c/$cluster/gateways/$namespace/$name",
  });
};

describe("a Gateway's listener rows", () => {
  /**
   * Any False read as broken, so an Istio listener that reported
   * `Conflicted=False · NoConflicts` sat on the page in red — the same
   * reading the peek had, fixed in both.
   */
  it("reads a listener's conditions by their own polarity", async () => {
    await open(
      edge([
        said("Accepted", "True", "Accepted"),
        said("Conflicted", "False", "NoConflicts"),
      ])
    );
    expect(screen.queryByText(/NoConflicts/)).toBeNull();
  });

  /**
   * `OverlappingTLSConfig=True` is set on listeners that go on serving, and
   * the row called it broken, in red. Fails if it is drawn as a failure, or
   * not drawn at all.
   */
  it("names an overlapping TLS config as a caution, not a break", async () => {
    await open(
      edge([
        said("Accepted", "True", "Accepted"),
        said("OverlappingTLSConfig", "True", "OverlappingHostnames"),
      ])
    );
    const caution = screen.getByText(/OverlappingHostnames/);
    expect(caution).toHaveClass("text-warn");
    expect(caution).not.toHaveClass("text-err");
  });

  it("still names the condition that broke it", async () => {
    await open(edge([said("ResolvedRefs", "False", "InvalidCertificateRef")]));
    expect(screen.getByText(/InvalidCertificateRef/)).toBeTruthy();
  });
});

describe("a Gateway its controller refused", () => {
  /**
   * bad-gw's own page said "Programmed: ListenersNotValid" and
   * "odd · PortUnavailable", while the route chain through it said which
   * port had no entry point and what that meant. Fails if the page stops
   * leading with the controller's answer and the listener it refused, or
   * says so about a Gateway that is programmed.
   */
  it("leads with the controller's answer and the listener under it", async () => {
    await open({
      ...edge([
        {
          ...said("Accepted", "False", "PortUnavailable"),
          message: "no matching entryPoint for port 9999",
        },
      ]),
      conditions: [
        {
          ...said("Accepted", "False", "ListenersNotValid"),
          message: "All Listeners must be valid",
        },
      ],
    });
    expect(
      screen.getByText("The controller refuses this Gateway")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /^ListenersNotValid: All Listeners must be valid\. Listener https: PortUnavailable: no matching entryPoint for port 9999\. Nothing behind it serves/
      )
    ).toBeInTheDocument();
  });

  it("says nothing of a refusal over a programmed Gateway", async () => {
    await open(edge([said("Accepted", "True", "Accepted")]));
    expect(
      screen.queryByText("The controller refuses this Gateway")
    ).toBeNull();
  });
});

describe("a Gateway's Routes tab", () => {
  afterEach(() => {
    for (const name of Object.keys(answers)) delete answers[name];
  });

  /**
   * The tab wore "0" while the routes across the cluster were still being
   * read. Fails if a list still on its way is counted as none.
   */
  it("wears no number while the routes are still being read", async () => {
    answers.detectGatewayApi = async () => ({
      installed: true,
      bundleVersion: "v1.2.0",
      channel: "standard",
      mixedBundle: false,
      kinds: [
        {
          kind: "HTTPRoute",
          plural: "httproutes",
          versions: ["v1"],
          readVersion: "v1",
        },
      ],
    });
    answers.listGatewayRoutes = () => new Promise(() => {});
    await open(edge([said("Accepted", "True", "Accepted")]));

    expect(screen.getByRole("tab", { name: /Routes/ }).textContent).not.toMatch(
      /\d/
    );
  });
});

describe("a Gateway's CRD bundle", () => {
  afterEach(() => {
    for (const name of Object.keys(answers)) delete answers[name];
    useClusterStore.setState({ isConnected: false, currentContext: null });
  });

  /**
   * A reader bound per namespace cannot list CRDs, and the page said nothing
   * about the bundle, which is what it says when the bundle is whole. Fails if
   * a bundle nobody could read is left unsaid.
   */
  it("says the bundle was not read where the CRDs could not be listed", async () => {
    answers.detectGatewayApi = async () => ({
      installed: true,
      bundleVersion: null,
      channel: null,
      mixedBundle: null,
      kinds: [],
    });
    useClusterStore.setState({ isConnected: true, currentContext: "prod" });
    await open(edge([said("Accepted", "True", "Accepted")]));

    expect(await screen.findByText(/^not read: the CRDs/)).toBeTruthy();
    expect(screen.queryByText(/^mixed versions/)).toBeNull();
  });
});
