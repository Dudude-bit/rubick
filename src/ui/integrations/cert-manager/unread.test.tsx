import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import type { CustomResourceInfo } from "@/generated/types";
import { renderWithRouter, testQueryClient } from "@/test/render";

/** What this cluster answers for each CRD, per test. */
const answers = vi.hoisted(
  () => new Map<string, () => Promise<CustomResourceInfo[]>>()
);
const ingresses = vi.hoisted(() => ({
  list: (): Promise<unknown[]> => Promise.resolve([]),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    listCustomResources: (crd: string) =>
      (answers.get(crd) ?? (() => Promise.resolve([])))(),
    // Read for the hosts each certificate serves. Nothing here is about
    // Ingresses, but the page reads them, and a mock that omits it makes
    // every one of these look like an unread-CRD bug.
    listIngresses: () => ingresses.list(),
  },
}));

import {
  CERTIFICATES_CRD,
  CLUSTER_ISSUERS_CRD,
  CHALLENGES_CRD,
  INGRESSES,
  ISSUERS_CRD,
  ORDERS_CRD,
} from "./model";

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
  const client = testQueryClient();
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function renderPage(tab = "issuers") {
  return renderWithRouter(<CertManagerPage />, {
    at: `/c/test/integrations/cert-manager?tab=${tab}`,
    route: "/c/$cluster/integrations/$vendor",
  });
}

beforeEach(() => {
  answers.clear();
  ingresses.list = () => Promise.resolve([]);
});

/** A refusal as the command wrapper throws it: the backend's code one level down. */
const refused = (said: string) =>
  new Error(`Tauri command 'list' failed: Kubernetes API error: ${said}`, {
    cause: { code: "PERMISSION_DENIED", message: said, said },
  });

/** The API server's 403 where one of the reader's bindings names a role that is gone. */
const DENIED_BY_GONE_ROLE = `issuers.cert-manager.io is forbidden: User "dev" cannot list resource "issuers" in API group "cert-manager.io" at the cluster scope: RBAC: clusterrole.rbac.authorization.k8s.io "viewer" not found`;

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

    await renderPage();

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
    await renderPage();

    await waitFor(() =>
      expect(
        screen.getByText("This cluster has no Issuer and no ClusterIssuer.")
      ).toBeInTheDocument()
    );
  });
});

describe("a refusal whose sentence says not found", () => {
  /**
   * "Not served" was read off the words, and this 403 ends in `"viewer" not
   * found`. Fails if a refused Issuer list is filed as a kind the cluster
   * does not have, with no unread note.
   */
  it("is a failed read by its code, not a kind the cluster does not serve", async () => {
    answers.set(ISSUERS_CRD, () =>
      Promise.reject(refused(DENIED_BY_GONE_ROLE))
    );

    const { result } = renderHook(() => usePicture(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.unread.map((kind) => kind.kind)).toEqual([
      "Issuer",
    ]);
  });

  /** The same on the screen: the strongest claim on the page is not made. */
  it("does not let the Issuers tab say the cluster has none", async () => {
    answers.set(ISSUERS_CRD, () =>
      Promise.reject(refused(DENIED_BY_GONE_ROLE))
    );

    await renderPage();

    await waitFor(() =>
      expect(screen.getByText(/"viewer" not found/)).toBeInTheDocument()
    );
    expect(
      screen.queryByText("This cluster has no Issuer and no ClusterIssuer.")
    ).not.toBeInTheDocument();
  });
});

describe("an Ingress list that could not be read", () => {
  const stuck = {
    name: "web",
    namespace: "shop",
    uid: "c-1",
    apiVersion: "cert-manager.io/v1",
    kind: "Certificate",
    spec: {
      secretName: "web-tls",
      dnsNames: ["shop.example.com"],
      issuerRef: { name: "ca" },
    },
    status: {
      conditions: [{ type: "Ready", status: "False", reason: "Pending" }],
    },
    labels: {},
    annotations: {},
    createdAt: null,
    ownerReferences: [],
    generation: 1,
  } as CustomResourceInfo;
  const FORBIDDEN_INGRESSES = "ingresses.networking.k8s.io is forbidden";

  beforeEach(() => {
    answers.set(CERTIFICATES_CRD, () => Promise.resolve([stuck]));
    ingresses.list = () => Promise.reject(refused(FORBIDDEN_INGRESSES));
  });

  /**
   * The list came back through `.catch(() => [])`. Fails if a certificate
   * whose users were never read is filed as mounted by no Ingress.
   */
  it("leaves each certificate's users unchecked and says which read failed", async () => {
    const { result } = renderHook(() => usePicture(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.certificates[0].use).toEqual({
      hosts: [],
      checked: false,
      unusedIsCertain: false,
    });
    expect(result.current.data?.unread).toEqual([
      { kind: "Ingress", crd: INGRESSES, reason: FORBIDDEN_INGRESSES },
    ]);
  });

  /** The row said "No Ingress in shop mounts web-tls" as what was checked, when nothing was. */
  it("says on the row that what serves it was not checked", async () => {
    await renderPage("certificates");

    expect(
      await screen.findByText(/What serves this certificate was not checked/)
    ).toBeInTheDocument();
    expect(screen.getByText(FORBIDDEN_INGRESSES)).toBeInTheDocument();
    expect(screen.queryByText(/No Ingress in/)).not.toBeInTheDocument();
  });

  /** The other half: read and empty, "no Ingress mounts it" is what was checked. */
  it("says no Ingress mounts it once the list was read", async () => {
    ingresses.list = () => Promise.resolve([]);

    await renderPage("certificates");

    expect(await screen.findByText(/No Ingress in/)).toBeInTheDocument();
    expect(screen.queryByText(/was not checked/)).not.toBeInTheDocument();
  });
});
