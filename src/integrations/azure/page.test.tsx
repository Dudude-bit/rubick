import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const answers = vi.hoisted(() => ({
  crds: (_crd: string): Promise<unknown[]> => Promise.resolve([]),
  pods: (): Promise<unknown[]> => Promise.resolve([]),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    listCustomResources: (crd: string) => answers.crds(crd),
    listPods: () => answers.pods(),
    getObjectMetadata: () => Promise.resolve({ annotations: {} }),
  },
}));

const { default: AksAddonsPage } = await import("./page");
const { AZURE_IDENTITY_CRD, PROHIBITED_TARGET_CRD } = await import("./model");
const { en } = await import("@/i18n/catalogue");

const failure = (code: string, message: string) =>
  Promise.reject(
    new Error(`Tauri command 'listCustomResources' failed: ${message}`, {
      cause: { code, message },
    })
  );

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/integrations/aks-addons"]}>
        {children}
      </MemoryRouter>
    </QueryClientProvider>
  );
  return render(<AksAddonsPage />, { wrapper });
}

beforeEach(() => {
  answers.crds = () => failure("NOT_FOUND", "not found");
  answers.pods = () => Promise.resolve([]);
});

describe("the AKS add-ons page", () => {
  /**
   * The data kept a refused `azureidentities` as unknown, and the page read
   * it through `?? false` — "not installed" over a list nobody got. Fails if
   * the unknown is collapsed on the way to the screen again.
   */
  it("does not call the retired add-on absent when its kinds were refused", async () => {
    answers.crds = (crd) =>
      crd === AZURE_IDENTITY_CRD
        ? failure("PERMISSION_DENIED", "azureidentities is forbidden")
        : failure("NOT_FOUND", "not found");

    renderPage();

    await screen.findByText(/No pod in this cluster carries/);
    expect(
      screen.queryByText(en.empty.legacyAddonNotInstalled.trim(), {
        exact: false,
      })
    ).toBeNull();
  });

  /** Read and not served is the one real "not installed". */
  it("says the retired add-on is not installed when its kinds are not served", async () => {
    renderPage();

    expect(
      await screen.findByText(en.empty.legacyAddonNotInstalled.trim(), {
        exact: false,
      })
    ).toBeInTheDocument();
  });

  /**
   * The add-on is decided from its own two kinds, and the sentence said
   * "its three kinds are not served" — counting AGIC's, which beside it had
   * been refused rather than found missing.
   */
  it("names only the add-on's own kinds as not served, not AGIC's refused one", async () => {
    answers.crds = (crd) =>
      crd === PROHIBITED_TARGET_CRD
        ? failure(
            "PERMISSION_DENIED",
            "azureingressprohibitedtargets is forbidden"
          )
        : failure("NOT_FOUND", "not found");

    renderPage();

    const sentence = await screen.findByText(/add-on is not installed/);
    expect(sentence).toHaveTextContent(
      "AzureIdentity and AzureIdentityBinding"
    );
    expect(sentence).not.toHaveTextContent(
      /three|AzureIngressProhibitedTarget/
    );
  });

  /**
   * With the labelled pods refused the header read "0 identities" over a
   * list nobody got. Fails if the count is drawn without the pods read.
   */
  it("draws no count when the pods that name identities were refused", async () => {
    answers.pods = () => failure("PERMISSION_DENIED", "pods is forbidden");

    renderPage();

    await screen.findByText(/could not be listed/);
    expect(screen.queryByText("0 identities")).toBeNull();
  });
});
