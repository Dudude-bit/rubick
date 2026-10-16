import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { screen, waitFor } from "@testing-library/react";

import { renderWithRouter } from "@/test/render";

const answers = vi.hoisted(() => new Map<string, () => Promise<unknown>>());

vi.mock("@/lib/commands", () => ({
  commands: {
    listCustomResources: (crd: string) =>
      (answers.get(crd) ?? (() => Promise.resolve([])))(),
    listNetworkPoliciesIn: () =>
      (
        answers.get("networkpolicies") ??
        (() => Promise.resolve({ rows: [], unread: [] }))
      )(),
  },
}));

const { KINDS } = await import("./data");
const { useClusterStore } = await import("@/stores/clusterStore");
const { en } = await import("@/i18n/catalogue");
const { TONE_TEXT } = await import("@/lib/tone");
const { default: CiliumPage } = await import("./page");

const FORBIDDEN = `ciliumendpoints.cilium.io is forbidden: User "dev" cannot list resource "ciliumendpoints" at the cluster scope`;

function renderPage() {
  return renderWithRouter(<CiliumPage />, {
    at: "/c/test/integrations/cilium",
    route: "/c/$cluster/integrations/$vendor",
  });
}

beforeEach(() => answers.clear());

const API_ENDPOINT = {
  name: "api-585bf77d99-xtwfs",
  namespace: "net",
  kind: "CiliumEndpoint",
  spec: null,
  status: { identity: { id: 1, labels: ["k8s:app=api"] } },
};

const DEFAULT_DENY = {
  name: "default-deny-ingress",
  namespace: "net",
  selects: { kind: "everything" },
  selected: 4,
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
};

describe("the Cilium page", () => {
  /**
   * The page never read `picture.error`: a refused endpoints list left an
   * empty coverage, and the list said `Nothing matches “”.` with no filter
   * typed and no retry — a cluster it could not read drawn as one with
   * nothing wrong.
   */
  it("says the read failed when a list is refused", async () => {
    answers.set(KINDS.endpoints, () =>
      Promise.reject(
        new Error(`Tauri command 'listCustomResources' failed: ${FORBIDDEN}`, {
          cause: { code: "PERMISSION_DENIED", message: FORBIDDEN },
        })
      )
    );

    await renderPage();

    await waitFor(() =>
      expect(
        screen.getByText("Could not read Cilium's endpoints and policies")
      ).toBeInTheDocument()
    );
    expect(screen.queryByText(/Nothing matches/)).not.toBeInTheDocument();
  });

  /**
   * An endpoint a policy might select, whose rules could not be read, wore
   * the same amber as one nothing selects — two answers told apart only by
   * the word. Fails if `cannotSay` takes the `unrestricted` tone again.
   */
  it("greys an endpoint it cannot decide apart from one nothing selects", async () => {
    answers.set(KINDS.endpoints, () =>
      Promise.resolve([
        {
          name: "api",
          namespace: "shop",
          kind: "CiliumEndpoint",
          spec: null,
          status: { identity: { id: 1, labels: ["k8s:app=api"] } },
        },
      ])
    );
    answers.set(KINDS.policies, () =>
      Promise.resolve([
        {
          name: "p",
          namespace: "shop",
          kind: "CiliumNetworkPolicy",
          spec: null,
          status: { conditions: [{ type: "Valid", status: "True" }] },
        },
      ])
    );

    await renderPage();

    const state = await screen.findByText(en.readings.ciliumCannotSay);
    expect(state).toHaveClass(TONE_TEXT.unknown);
    expect(state).not.toHaveClass(TONE_TEXT.warn);
  });

  /** Read and empty is its own sentence, not an empty search. */
  it("says there are no endpoints when the lists answered empty", async () => {
    await renderPage();

    await waitFor(() =>
      expect(
        screen.getByText(/No CiliumEndpoint in this cluster/)
      ).toBeInTheDocument()
    );
    expect(screen.queryByText(/Nothing matches/)).not.toBeInTheDocument();
  });

  /**
   * The persona review's blocker: a pod under a default-deny NetworkPolicy
   * was "nothing selects it" here. The row names the NetworkPolicy and says
   * ingress is restricted; egress, which it does not govern, stays open,
   * and the row's word is amber, not the green "covered" it once was.
   */
  it("names the NetworkPolicy that restricts an endpoint's ingress", async () => {
    answers.set(KINDS.endpoints, () => Promise.resolve([API_ENDPOINT]));
    answers.set("networkpolicies", () =>
      Promise.resolve({ rows: [DEFAULT_DENY], unread: [] })
    );

    await renderPage();

    const state = await screen.findByText("only Ingress restricted");
    expect(state).toHaveClass(TONE_TEXT.warn);
    expect(
      screen.queryByText(en.readings.ciliumCovered)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(en.readings.ciliumUnrestricted)
    ).not.toBeInTheDocument();
  });

  /** A refused NetworkPolicy read is said, and no endpoint reads as open. */
  it("says the NetworkPolicies were refused rather than call endpoints open", async () => {
    answers.set(KINDS.endpoints, () => Promise.resolve([API_ENDPOINT]));
    answers.set("networkpolicies", () =>
      Promise.reject(new Error("networkpolicies is forbidden"))
    );

    await renderPage();

    expect(
      await screen.findByText(en.readings.ciliumFindingKubernetesUnread)
    ).toBeInTheDocument();
    expect(screen.getByText(en.readings.ciliumCannotSay)).toHaveClass(
      TONE_TEXT.unknown
    );
    expect(
      screen.queryByText(en.readings.ciliumUnrestricted)
    ).not.toBeInTheDocument();
  });

  /** The page drew k8s-gui-test and team-checkout pods under a picker on net. */
  it("draws only the endpoints in the namespaces the picker names", async () => {
    useClusterStore.setState({ namespaceScope: ["net"] });
    answers.set(KINDS.endpoints, () =>
      Promise.resolve([
        API_ENDPOINT,
        { ...API_ENDPOINT, name: "checkout-api-1", namespace: "team-checkout" },
      ])
    );

    await renderPage();

    expect(await screen.findByText(API_ENDPOINT.name)).toBeInTheDocument();
    expect(screen.queryByText("checkout-api-1")).not.toBeInTheDocument();
    useClusterStore.setState({ namespaceScope: [] });
  });
});
