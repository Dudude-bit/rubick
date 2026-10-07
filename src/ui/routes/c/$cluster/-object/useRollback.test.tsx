import { describe, expect, it, vi } from "vite-plus/test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { DeploymentContainerInfo, ProbeInfo } from "@/generated/types";
import type { Revision } from "@/lib/changes";
import { renderWithRouter } from "@/test/render";

vi.mock("@/lib/commands", () => ({
  commands: { rollbackWorkload: vi.fn() },
}));

import { commands } from "@/lib/commands";
import { useRollback } from "./useRollback";

const probe = (path: string): ProbeInfo => ({
  handler: { type: "httpGet", path, port: "http", scheme: "HTTP", host: null },
  initialDelaySeconds: 0,
  periodSeconds: 5,
  timeoutSeconds: 1,
  successThreshold: 1,
  failureThreshold: 3,
});

const app = (path: string): DeploymentContainerInfo => ({
  name: "app",
  image: "nginx:1.27-alpine",
  phase: "app",
  ports: [80],
  resources: { requests: {}, limits: {} },
  probes: { readiness: probe(path), liveness: null, startup: null },
  env: [],
  envFrom: [],
  command: [],
  args: [],
});

const revision = (
  number: number,
  path: string,
  current: boolean
): Revision => ({
  id: `rs-${number}`,
  number,
  name: `search-${number}`,
  current,
  at: null,
  changeCause: null,
  containers: [app(path)],
  initContainers: [],
  templateAnnotations: {},
  templateKnown: true,
  template: null,
});

const SEARCH = [revision(1, "/", false), revision(2, "/healthz", true)];

function Harness() {
  const rollback = useRollback({
    subject: { kind: "Deployment", name: "search", namespace: "shop" },
    revisions: SEARCH,
    intercept: null,
  });
  return (
    <>
      <button type="button" onClick={() => rollback.offer(SEARCH[0])}>
        offer
      </button>
      {rollback.dialog}
    </>
  );
}

describe("rolling a workload back to a revision", () => {
  /**
   * Dana fixed `search` by editing YAML at line 42. The way out is one
   * action, and before it runs it says what will change: the probe path
   * goes back from /healthz to /.
   */
  it("shows what will change and rolls back only once confirmed", async () => {
    vi.mocked(commands.rollbackWorkload).mockResolvedValue({
      outcome: "rolledBack",
    });
    await renderWithRouter(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "offer" }));
    const changes = await screen.findByTestId("rollback-changes");
    expect(changes).toHaveTextContent("readinessProbe.httpGet.path");
    expect(changes).toHaveTextContent("/healthz → /");
    expect(commands.rollbackWorkload).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Roll back" }));
    await waitFor(() =>
      expect(commands.rollbackWorkload).toHaveBeenCalledWith(
        "Deployment",
        "search",
        "shop",
        1
      )
    );
  });

  /** Lena read "deployment" lowercased in a Russian sentence while Restart said "Deployment". Fails if the dialog lowercases the kind again. */
  it("titles the dialog with the kind as Kubernetes spells it", async () => {
    await renderWithRouter(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "offer" }));
    expect(
      await screen.findByText("Roll back Deployment shop/search to revision 1?")
    ).toBeInTheDocument();
  });
});
