import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { CustomResourceInfo } from "@/generated/types";

const answers = vi.hoisted(() => ({
  deployments: (): Promise<unknown[]> => Promise.resolve([]),
  crds: new Map<string, () => Promise<CustomResourceInfo[]>>(),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    listCustomResources: (crd: string) =>
      (answers.crds.get(crd) ?? (() => Promise.resolve([])))(),
    listDeployments: () => answers.deployments(),
  },
}));

const { default: FluxPage } = await import("./page");

const FORBIDDEN =
  'deployments.apps is forbidden: User "dev" cannot list resource "deployments" in API group "apps" at the cluster scope';

const refused = (words: string) =>
  new Error(`Tauri command 'listDeployments' failed: ${words}`, {
    cause: { code: "PERMISSION_DENIED", message: words },
  });

function renderOn(tab: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/integrations/flux?tab=${tab}`]}>
        {children}
      </MemoryRouter>
    </QueryClientProvider>
  );
  return render(<FluxPage />, { wrapper });
}

beforeEach(() => {
  answers.deployments = () => Promise.resolve([]);
  answers.crds.clear();
});

const GIT_REPOSITORIES = "gitrepositories.source.toolkit.fluxcd.io";
const SOURCES_FORBIDDEN = `gitrepositories.source.toolkit.fluxcd.io is forbidden: User "dev" cannot list resource "gitrepositories"`;

const refusedList = () =>
  Promise.reject(
    new Error(
      `Tauri command 'listCustomResources' failed: ${SOURCES_FORBIDDEN}`,
      {
        cause: { code: "PERMISSION_DENIED", message: SOURCES_FORBIDDEN },
      }
    )
  );

const notServed = () =>
  Promise.reject(
    new Error("Tauri command 'listCustomResources' failed: not found", {
      cause: { code: "NOT_FOUND", message: "not found" },
    })
  );

describe("a source kind the reader may not list", () => {
  /**
   * `listOptional` caught every error as "kind not served", so a refused
   * `gitrepositories` read as a cluster fetching nothing at all.
   */
  it("is named as unread rather than drawn as no sources", async () => {
    answers.crds.set(GIT_REPOSITORIES, refusedList);

    renderOn("sources");

    await waitFor(() =>
      expect(screen.getByText(SOURCES_FORBIDDEN)).toBeInTheDocument()
    );
    expect(screen.queryByText(/^No source objects/)).not.toBeInTheDocument();
  });

  /** A kind the API server does not serve is still simply none. */
  it("is none when the kind is not served", async () => {
    answers.crds.set(GIT_REPOSITORIES, notServed);

    renderOn("sources");

    await waitFor(() =>
      expect(screen.getByText(/^No source objects/)).toBeInTheDocument()
    );
  });
});

describe("the Controllers tab", () => {
  /**
   * The Deployments list went through `.catch(() => [])`, so a token that
   * reads Flux's objects but not cluster-wide Deployments was told no Flux
   * controller runs and nothing is being acted on.
   */
  it("says the controllers could not be looked for when the list is refused", async () => {
    answers.deployments = () => Promise.reject(refused(FORBIDDEN));

    renderOn("controllers");

    await waitFor(() =>
      expect(screen.getByText(new RegExp(FORBIDDEN))).toBeInTheDocument()
    );
    expect(
      screen.queryByText(/Nothing in this cluster carries/)
    ).not.toBeInTheDocument();
  });

  /** Read and empty is the one case where "none running" is the answer. */
  it("says none carries the label when the list answered empty", async () => {
    renderOn("controllers");

    await waitFor(() =>
      expect(
        screen.getByText(/Nothing in this cluster carries/)
      ).toBeInTheDocument()
    );
  });
});
