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
    listDeployments: () => Promise.resolve([]),
    listStatefulsets: () => Promise.resolve([]),
    listIngresses: () => Promise.resolve([]),
  },
}));

const { APPLICATIONSETS_CRD, PROJECTS_CRD } = await import("./data");
const { default: ArgoCdPage } = await import("./page");

const refused = (crd: string) => () =>
  Promise.reject(
    new Error(
      `Tauri command 'listCustomResources' failed: ${crd} is forbidden`,
      {
        cause: { code: "PERMISSION_DENIED", message: "forbidden" },
      }
    )
  );

function renderOn(tab: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/integrations/argocd?tab=${tab}`]}>
        {children}
      </MemoryRouter>
    </QueryClientProvider>
  );
  return render(<ArgoCdPage />, { wrapper });
}

beforeEach(() => answers.clear());

describe("tabs whose own list was refused", () => {
  /**
   * The ApplicationSets tab drew `sets.data ?? []`, so a refusal — and the
   * seconds before any answer — read "every Application here was written by
   * hand".
   */
  it("does not call a refused ApplicationSet list none", async () => {
    answers.set(APPLICATIONSETS_CRD, refused(APPLICATIONSETS_CRD));

    renderOn("appsets");

    await waitFor(() =>
      expect(
        screen.getByText(
          new RegExp(`${APPLICATIONSETS_CRD} could not be listed`)
        )
      ).toBeInTheDocument()
    );
    expect(
      screen.queryByText(/No ApplicationSet in this cluster/)
    ).not.toBeInTheDocument();
  });

  /** The same for AppProjects, which every install has at least one of. */
  it("does not call a refused AppProject list none", async () => {
    answers.set(PROJECTS_CRD, refused(PROJECTS_CRD));

    renderOn("projects");

    await waitFor(() =>
      expect(
        screen.getByText(new RegExp(`${PROJECTS_CRD} could not be listed`))
      ).toBeInTheDocument()
    );
    expect(
      screen.queryByText(/has no AppProject objects/)
    ).not.toBeInTheDocument();
  });
});
