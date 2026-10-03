import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { CustomResourceInfo } from "@/generated/types";

/** What this cluster answers for each CRD, per test. */
const answers = vi.hoisted(
  () => new Map<string, () => Promise<CustomResourceInfo[]>>()
);

vi.mock("@/lib/commands", () => ({
  commands: {
    listCustomResources: (crd: string) =>
      (answers.get(crd) ?? (() => Promise.resolve([])))(),
    // Read for the hosts each certificate serves. Nothing here is about
    // Ingresses, but the page reads them, and a mock that omits it makes
    // every one of these look like an unread-CRD bug.
    listIngresses: () => Promise.resolve([]),
  },
}));

import { CLUSTER_ISSUERS_CRD, CHALLENGES_CRD, ORDERS_CRD } from "./model";

const { usePicture } = await import("./data");
const { default: CertManagerPage } = await import("./page");

/** The shape a missing CRD comes back in: the API server never found one. */
const notServed = (crd: string) =>
  new Error(
    `Tauri command 'listCustomResources' failed: Kubernetes API error: ApiError: customresourcedefinitions.apiextensions.k8s.io "${crd}" not found: NotFound (ErrorResponse { status: "Failure", reason: "NotFound", code: 404 })`
  );

/** The shape a denial comes back in, which says nothing about existence. */
const FORBIDDEN = `clusterissuers.cert-manager.io is forbidden: User "dev" cannot list resource "clusterissuers" in API group "cert-manager.io" at the cluster scope`;

const denied = () =>
  new Error(`Tauri command 'listCustomResources' failed: ${FORBIDDEN}`);

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/integrations/cert-manager?tab=issuers"]}>
        {children}
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  answers.clear();
});

describe("a kind the cluster does not serve", () => {
  /**
   * Would break if a missing CRD started reading as a failure: a CA-only
   * install has no ACME kinds at all, and a page reporting "could not read
   * the Orders" on one would be calling a supported configuration broken.
   */
  it("is an absence, and says nothing about it", async () => {
    answers.set(ORDERS_CRD, () => Promise.reject(notServed(ORDERS_CRD)));
    answers.set(CHALLENGES_CRD, () =>
      Promise.reject(notServed(CHALLENGES_CRD))
    );

    const { result } = renderHook(() => usePicture(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.unread).toEqual([]);
    expect(result.current.data?.acme).toBe(false);
  });
});

describe("a kind this reader is not allowed to read", () => {
  /**
   * Would break if a denial went back to being swallowed into an empty list.
   * `clusterissuers` is cluster-scoped and ships with every install, so this
   * is an ordinary kubeconfig rather than an exotic one — and the empty list
   * it used to produce was indistinguishable from a cluster with no issuer.
   */
  it("is not an absence, and comes back in the API server's own words", async () => {
    answers.set(CLUSTER_ISSUERS_CRD, () => Promise.reject(denied()));

    const { result } = renderHook(() => usePicture(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.unread).toEqual([
      {
        kind: "ClusterIssuer",
        crd: CLUSTER_ISSUERS_CRD,
        reason: FORBIDDEN,
      },
    ]);
  });
});

describe("what the issuers tab is allowed to claim", () => {
  /**
   * The finding this whole read exists for. Would break if the page went back
   * to telling a reader with a working ClusterIssuer that the cluster has
   * none — advice that ends in them creating a second one.
   */
  it("never states an absence on the strength of a read that failed", async () => {
    answers.set(CLUSTER_ISSUERS_CRD, () => Promise.reject(denied()));

    render(<CertManagerPage />, { wrapper: wrapper() });

    await waitFor(() =>
      expect(screen.getByText(FORBIDDEN)).toBeInTheDocument()
    );
    expect(
      screen.queryByText("This cluster has no Issuer and no ClusterIssuer.")
    ).not.toBeInTheDocument();
  });

  /**
   * The other half: the claim is a good one when both kinds were actually
   * read, and losing it would leave the page saying nothing on the cluster
   * where "there is no issuer" is the whole answer.
   */
  it("states it when both kinds were read and both are empty", async () => {
    render(<CertManagerPage />, { wrapper: wrapper() });

    await waitFor(() =>
      expect(
        screen.getByText("This cluster has no Issuer and no ClusterIssuer.")
      ).toBeInTheDocument()
    );
  });
});
