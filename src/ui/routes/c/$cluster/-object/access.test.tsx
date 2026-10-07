import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { UseMutationResult } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";

import type { AccessAnswer, AccessQuery } from "@/generated/types";

const checkAccess = vi.hoisted(() => vi.fn());
vi.mock("@/lib/commands", async (original) => {
  const real = await original<typeof import("@/lib/commands")>();
  return {
    commands: {
      ...real.commands,
      checkAccess,
      getSecret: vi.fn(async () => SECRET),
      getDeployment: vi.fn(async () => WORKER),
      getPod: vi.fn(async () => API_POD),
    },
  };
});

import { hrefOf, objectLink } from "@/lib/links";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";
import { PeekActions } from "../-peek/PeekActions";
import { ResourceList } from "../-list/ResourceList";
import PaletteActionsHost from "../-shell/PaletteActionsHost";
import type { ActionsReport } from "../-shell/palette-actions";
import { DeleteAction } from "./DeleteAction";
import { RestartAction } from "./RestartDialog";
import { marcoReview } from "@/test/marco";

const SECRET = { name: "checkout-db", namespace: "team-checkout" };
const WORKER = {
  name: "checkout-worker",
  namespace: "team-checkout",
  replicas: { desired: 2, ready: 2, available: 2, updated: 2 },
};

/**
 * Marco's Role in team-checkout, as `kubectl auth can-i` answers it: he may
 * delete pods and jobs there and nothing else, and patch nothing.
 */
function marco(queries: AccessQuery[]): AccessAnswer[] {
  return queries.map((query) => ({
    verb: query.verb,
    resource: query.resource,
    allowed:
      query.namespace === "team-checkout" &&
      query.verb === "delete" &&
      ["pods", "jobs"].includes(query.resource),
  }));
}

/** checkout-api's pod as the cluster reads it: running, one container on 8080. */
const API_POD = {
  name: "checkout-api-6767fbfdb7-blpfk",
  namespace: "team-checkout",
  status: { phase: "Running", display: "Running" },
  containers: [
    {
      name: "api",
      image: "ghcr.io/acme/checkout-api:1.4.2",
      ready: true,
      restartCount: 0,
      state: { type: "running", startedAt: "2026-10-06T21:00:00Z" },
      ports: [{ containerPort: 8080, name: "http", protocol: "TCP" }],
    },
  ],
  initContainers: [],
  ownerReferences: [
    {
      api_version: "apps/v1",
      kind: "ReplicaSet",
      name: "checkout-api-6767fbfdb7",
      uid: "rs",
      controller: true,
    },
  ],
};

const mutation = (mutate = vi.fn()) =>
  ({ mutate, isPending: false }) as unknown as UseMutationResult<
    void,
    Error,
    void
  >;

beforeEach(() => {
  checkAccess.mockReset();
  checkAccess.mockImplementation(async (queries: AccessQuery[]) =>
    marco(queries)
  );
  useClusterStore.setState((s) => ({
    currentContext: "acme-staging",
    isConnected: true,
    namespaceScope: ["team-checkout"],
    connectionAttemptId: s.connectionAttemptId + 1,
  }));
});

const deleteButton = () => screen.getByRole("button", { name: /^Delete$/ });

describe("Delete for a reader who may not delete", () => {
  /**
   * Marco's Secret peek carried a red Delete that the cluster would refuse
   * after he typed the name. Fails if the peek offers it as runnable.
   */
  it("is greyed in the peek with the access review's answer", async () => {
    await renderWithRouter(
      <PeekActions
        target={{ kind: "Secret", ...SECRET }}
        detail={SECRET}
        onClose={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(deleteButton()).toHaveAttribute("aria-disabled", "true")
    );
    fireEvent.focus(deleteButton());
    expect(
      (await screen.findAllByText(/can-i delete secrets -n team-checkout/))
        .length
    ).toBeGreaterThan(0);
    fireEvent.click(deleteButton());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  /** Fails if the guard shuts what the review allows: Marco may delete jobs. */
  it("stays offered where the review allows it", async () => {
    await renderWithRouter(
      <PeekActions
        target={{
          kind: "Job",
          name: "nightly-export",
          namespace: "team-checkout",
        }}
        detail={undefined}
        onClose={vi.fn()}
      />
    );
    await waitFor(() => expect(checkAccess).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Delete/ })).toBeEnabled()
    );
    expect(screen.getByRole("button", { name: /Delete/ })).not.toHaveAttribute(
      "aria-disabled"
    );
  });

  /** Fails if the detail page header still offers Delete as runnable. */
  it("is greyed on the Secret's page and opens no confirmation", async () => {
    await renderWithRouter(
      <DeleteAction
        kind="Secret"
        name={SECRET.name}
        namespace={SECRET.namespace}
        intercept={null}
        mutation={mutation()}
      />
    );

    await waitFor(() =>
      expect(deleteButton()).toHaveAttribute("aria-disabled", "true")
    );
    fireEvent.click(deleteButton());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  /** Restart is a patch, which Marco's Role does not grant either. */
  it("greys the Deployment page's Restart, which needs patch", async () => {
    await renderWithRouter(
      <RestartAction
        kind="Deployment"
        name={WORKER.name}
        namespace={WORKER.namespace}
        plan={undefined}
        intercept={null}
        mutation={mutation()}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Restart" })).toHaveAttribute(
        "aria-disabled",
        "true"
      )
    );
  });

  /**
   * The right-click menu and the row's own Delete button on Marco's
   * Deployments list. Fails if either still offers Delete as runnable.
   */
  it("is greyed in the row menu and on the row", async () => {
    await renderWithRouter(
      <ResourceList
        title="Deployments"
        emptyStateLabel="deployments"
        data={[WORKER]}
        columns={[
          {
            accessorKey: "name",
            header: "Name",
            cell: ({ row }) => (
              <span data-testid="cell">{row.original.name}</span>
            ),
          },
        ]}
        getRowHref={(row) =>
          hrefOf(objectLink({ kind: "Deployment", ...row })!)
        }
        quickActions={[
          {
            icon: Trash2,
            label: "Delete",
            onClick: vi.fn(),
            variant: "destructive",
          },
        ]}
      />,
      { at: "/c/acme-staging/deployments", route: "/c/$cluster/$" }
    );

    const row = screen.getByTestId("cell").closest("tr")!;
    await waitFor(() =>
      expect(
        within(row).getByRole("button", { name: "Delete" })
      ).toHaveAttribute("aria-disabled", "true")
    );

    fireEvent.contextMenu(screen.getByTestId("cell"), {
      clientX: 30,
      clientY: 40,
    });
    const item = await screen.findByRole("menuitem", { name: /^Delete/ });
    await waitFor(() => expect(item).toHaveAttribute("data-disabled"));
    expect(item.textContent).toContain(
      "can-i delete deployments.apps -n team-checkout"
    );
  });

  /** Fails if Ctrl+K offers what the peek and the menu have greyed. */
  it("comes to the palette with its reason", async () => {
    const reports: ActionsReport[] = [];
    await renderWithRouter(
      <PaletteActionsHost
        target={{
          context: "acme-staging",
          kind: "Secret",
          group: "",
          plural: "secrets",
          ...SECRET,
        }}
        onReport={(report) => {
          reports.push(report);
        }}
        ref={{ current: null }}
      />
    );
    await waitFor(() => {
      const last = reports.at(-1);
      expect(last?.reading).toBe("ready");
      const remove =
        last?.reading === "ready"
          ? last.actions.find((action) => action.id === "delete")
          : undefined;
      expect(remove?.reason).toMatch(/can-i delete secrets -n team-checkout/);
    });
  });
});

describe("Delete when the access review cannot answer", () => {
  /**
   * A cluster that would not say is not a cluster that said no. Fails if a
   * failed or unanswered review greys the action on a guess.
   */
  it("stays offered, with no claim, when the review fails or says nothing", async () => {
    for (const answer of [
      () => Promise.reject(new Error("connection reset by peer")),
      async (queries: AccessQuery[]) =>
        queries.map((query) => ({ ...query, allowed: null })),
    ]) {
      checkAccess.mockImplementation(answer);
      useClusterStore.setState((s) => ({
        connectionAttemptId: s.connectionAttemptId + 1,
      }));
      const view = await renderWithRouter(
        <DeleteAction
          kind="Secret"
          name={SECRET.name}
          namespace={SECRET.namespace}
          intercept={null}
          mutation={mutation()}
        />
      );
      await waitFor(() => expect(checkAccess).toHaveBeenCalled());
      expect(deleteButton()).not.toHaveAttribute("aria-disabled");
      fireEvent.click(deleteButton());
      expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
      view.unmount();
      checkAccess.mockClear();
    }
  });

  /**
   * The review allowed it and the call was refused anyway (a webhook, a
   * changed Role). Fails if that refusal is not remembered for the button.
   */
  it("is greyed once the cluster refused the delete itself", async () => {
    checkAccess.mockImplementation(async (queries: AccessQuery[]) =>
      queries.map((query) => ({ ...query, allowed: true }))
    );
    const mutate = vi.fn(
      (_: unknown, options: { onError: (e: Error) => void }) =>
        options.onError(
          new Error(
            'secrets "checkout-db" is forbidden: User "system:serviceaccount:team-checkout:marco" cannot delete resource "secrets" (code: 403)'
          )
        )
    );
    await renderWithRouter(
      <DeleteAction
        kind="Secret"
        name={SECRET.name}
        namespace={SECRET.namespace}
        intercept={null}
        mutation={mutation(mutate)}
      />
    );
    await waitFor(() => expect(checkAccess).toHaveBeenCalled());
    fireEvent.click(deleteButton());
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: SECRET.name },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(deleteButton()).toHaveAttribute("aria-disabled", "true")
    );
  });
});

describe("Debug for Marco, whose Role allows exec and port-forward and neither way of debugging", () => {
  beforeEach(() => {
    checkAccess.mockImplementation(marcoReview);
  });

  const podsList = () =>
    renderWithRouter(
      <ResourceList
        title="Pods"
        emptyStateLabel="pods"
        data={[API_POD]}
        columns={[
          {
            accessorKey: "name",
            header: "Name",
            cell: ({ row }) => (
              <span data-testid="cell">{row.original.name}</span>
            ),
          },
        ]}
        getRowHref={(row) => hrefOf(objectLink({ kind: "Pod", ...row })!)}
      />,
      { at: "/c/acme-staging/pods", route: "/c/$cluster/$" }
    );

  /**
   * Marco right-clicked checkout-api's row and Debug was live; its dialog
   * then offered Start Debug, which the cluster refuses both ways. Fails if
   * the menu's Debug is runnable, or if Shell and Port forward, which his
   * Role allows, are greyed with it.
   */
  it("is greyed in the pod row's menu with both can-i questions", async () => {
    await podsList();
    fireEvent.contextMenu(screen.getByTestId("cell"), {
      clientX: 30,
      clientY: 40,
    });
    const debug = await screen.findByRole("menuitem", { name: /^Debug/ });
    await waitFor(() => expect(debug).toHaveAttribute("data-disabled"));
    expect(debug.textContent).toContain(
      "can-i patch pods/ephemeralcontainers -n team-checkout and to kubectl auth can-i create pods -n team-checkout"
    );
    for (const offered of [/^Shell/, /^Port forward/])
      expect(
        screen.getByRole("menuitem", { name: offered })
      ).not.toHaveAttribute("data-disabled");
  });

  /** Fails if Ctrl+K offers the Debug the row menu has greyed. */
  it("comes to the palette with its reason", async () => {
    const reports: ActionsReport[] = [];
    await renderWithRouter(
      <PaletteActionsHost
        target={{
          context: "acme-staging",
          kind: "Pod",
          group: "",
          plural: "pods",
          name: API_POD.name,
          namespace: API_POD.namespace,
        }}
        onReport={(report) => {
          reports.push(report);
        }}
        ref={{ current: null }}
      />
    );
    await waitFor(() => {
      const last = reports.at(-1);
      const actions = last?.reading === "ready" ? last.actions : [];
      expect(actions.find((action) => action.id === "debug")?.reason).toMatch(
        /can-i patch pods\/ephemeralcontainers -n team-checkout/
      );
      expect(
        actions.find((action) => action.id === "shell")?.reason
      ).toBeUndefined();
    });
  });
});
