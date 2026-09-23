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

const HELM_RELEASES = "helmreleases.helm.toolkit.fluxcd.io";
const HELM_REPOSITORIES = "helmrepositories.source.toolkit.fluxcd.io";
const RELEASES_FORBIDDEN = `helmreleases.helm.toolkit.fluxcd.io is forbidden: User "dev" cannot list resource "helmreleases"`;

const failingChartRepo = (): CustomResourceInfo => ({
  name: "bitnami",
  namespace: "flux-system",
  uid: "helmrepo-bitnami",
  apiVersion: "source.toolkit.fluxcd.io/v1",
  kind: "HelmRepository",
  spec: { url: "https://charts.bitnami.com/bitnami", interval: "10m" },
  status: {
    conditions: [
      {
        type: "Ready",
        status: "False",
        reason: "IndexationFailed",
        message: "failed to fetch index: 503",
      },
    ],
  },
  labels: {},
  annotations: {},
  createdAt: null,
  ownerReferences: [],
  generation: null,
});

describe("a failing source when HelmReleases could not be listed", () => {
  /** The releases built from a chart repository are exactly the ones not read, so "nothing is affected" and "Applied by: nothing" were both said about a source freezing every release on it. Fails if `usersKnown` is ignored on the row. */
  it("says the releases were not read instead of saying nothing uses it", async () => {
    answers.crds.set(HELM_RELEASES, () =>
      Promise.reject(
        new Error(
          `Tauri command 'listCustomResources' failed: ${RELEASES_FORBIDDEN}`,
          {
            cause: { code: "PERMISSION_DENIED", message: RELEASES_FORBIDDEN },
          }
        )
      )
    );
    answers.crds.set(HELM_REPOSITORIES, () =>
      Promise.resolve([failingChartRepo()])
    );

    renderOn("sources");

    await waitFor(() =>
      expect(screen.getByText(/any built from this source/)).toBeInTheDocument()
    );
    expect(screen.getByText("HelmReleases not read")).toBeInTheDocument();
    expect(
      screen.queryByText(/Nothing names this source/)
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/^nothing$/)).not.toBeInTheDocument();
  });

  /** With HelmReleases read, an unused failing source really does affect nothing, and says so. */
  it("says nothing is affected when every reconciler kind was read", async () => {
    answers.crds.set(HELM_REPOSITORIES, () =>
      Promise.resolve([failingChartRepo()])
    );

    renderOn("sources");

    await waitFor(() =>
      expect(screen.getByText(/Nothing names this source/)).toBeInTheDocument()
    );
    expect(screen.getByText(/^nothing$/)).toBeInTheDocument();
  });
});
