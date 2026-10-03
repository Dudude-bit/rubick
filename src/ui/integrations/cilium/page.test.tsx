import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const answers = vi.hoisted(() => new Map<string, () => Promise<unknown[]>>());

vi.mock("@/lib/commands", () => ({
  commands: {
    listCustomResources: (crd: string) =>
      (answers.get(crd) ?? (() => Promise.resolve([])))(),
  },
}));

const { KINDS } = await import("./data");
const { en } = await import("@/i18n/catalogue");
const { TONE_TEXT } = await import("@/lib/tone");
const { default: CiliumPage } = await import("./page");

const FORBIDDEN = `ciliumendpoints.cilium.io is forbidden: User "dev" cannot list resource "ciliumendpoints" at the cluster scope`;

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/integrations/cilium"]}>
        {children}
      </MemoryRouter>
    </QueryClientProvider>
  );
  return render(<CiliumPage />, { wrapper });
}

beforeEach(() => answers.clear());

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

    renderPage();

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

    renderPage();

    const state = await screen.findByText(en.readings.ciliumCannotSay);
    expect(state).toHaveClass(TONE_TEXT.unknown);
    expect(state).not.toHaveClass(TONE_TEXT.warn);
  });

  /** Read and empty is its own sentence, not an empty search. */
  it("says there are no endpoints when the lists answered empty", async () => {
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText(/No CiliumEndpoint in this cluster/)
      ).toBeInTheDocument()
    );
    expect(screen.queryByText(/Nothing matches/)).not.toBeInTheDocument();
  });
});
