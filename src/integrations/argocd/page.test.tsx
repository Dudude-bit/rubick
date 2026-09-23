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
    listDeployments: () =>
      (answers.get("deployments") ?? (() => Promise.resolve([])))(),
    listStatefulsets: () =>
      (answers.get("statefulsets") ?? (() => Promise.resolve([])))(),
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

describe("Argo's own workloads", () => {
  const server = {
    name: "argocd-server",
    namespace: "argocd",
    containers: [{ image: "quay.io/argoproj/argocd:v3.1.0" }],
    replicas: { ready: 1, desired: 1 },
  };

  /**
   * The application controller is a StatefulSet. With StatefulSets refused
   * and Deployments found, the refusal was dropped because the list was not
   * empty, and the tab showed a list without its controller as the whole.
   * Fails if a read's failure is kept only when nothing was found.
   */
  it("names a refused kind beside the workloads the other kind found", async () => {
    answers.set("deployments", () => Promise.resolve([server]));
    answers.set("statefulsets", refused("statefulsets"));

    renderOn("controller");

    expect(
      await screen.findByText(
        "Could not list statefulsets, so any of Argo's own workloads among them are missing here."
      )
    ).toBeInTheDocument();
    expect(screen.getAllByText("argocd-server").length).toBeGreaterThan(0);
  });

  /**
   * Both refused read in the same faint grey as "nothing carries the
   * label". Fails if a failure is drawn as the empty answer.
   */
  it("does not say nothing carries the label when the lists were refused", async () => {
    answers.set("deployments", refused("deployments"));
    answers.set("statefulsets", refused("statefulsets"));

    renderOn("controller");

    expect(await screen.findByText(/Could not list deployments/)).toHaveClass(
      "text-warn"
    );
    expect(screen.queryByText(/Nothing in this cluster carries/)).toBeNull();
  });
});
