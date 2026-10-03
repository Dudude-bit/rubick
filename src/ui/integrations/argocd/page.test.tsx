import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";

import { useLocaleStore } from "@/stores/localeStore";
import { renderWithRouter } from "@/test/render";

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
  return renderWithRouter(<ArgoCdPage />, {
    at: `/c/test/integrations/argocd?tab=${tab}`,
    route: "/c/$cluster/integrations/$vendor",
  });
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

    await renderOn("appsets");

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

    await renderOn("projects");

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

    await renderOn("controller");

    expect(
      await screen.findByText(
        "Could not list statefulsets, so any of Argo's own workloads among them are missing here."
      )
    ).toBeInTheDocument();
    expect(screen.getAllByText("argocd-server").length).toBeGreaterThan(0);
  });

  /**
   * The Russian sentence read "Argo's own workloads among them are not here",
   * which a reader takes for "there are none" — about a list nobody read.
   */
  it("says in Russian that the workloads among a refused kind are not shown, not absent", async () => {
    useLocaleStore.setState({ choice: "ru" });
    answers.set("deployments", () => Promise.resolve([server]));
    answers.set("statefulsets", refused("statefulsets"));

    try {
      await renderOn("controller");

      const finding = await screen.findByText(/Не удалось перечислить/);
      expect(finding).toHaveTextContent("здесь не показаны");
      expect(finding).not.toHaveTextContent("здесь нет");
    } finally {
      useLocaleStore.setState({ choice: null });
    }
  });

  /**
   * Both refused read in the same faint grey as "nothing carries the
   * label". Fails if a failure is drawn as the empty answer.
   */
  it("does not say nothing carries the label when the lists were refused", async () => {
    answers.set("deployments", refused("deployments"));
    answers.set("statefulsets", refused("statefulsets"));

    await renderOn("controller");

    expect(await screen.findByText(/Could not list deployments/)).toHaveClass(
      "text-warn"
    );
    expect(screen.queryByText(/Nothing in this cluster carries/)).toBeNull();
  });
});
