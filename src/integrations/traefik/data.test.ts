import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/commands", () => ({
  commands: {
    listDeployments: vi.fn(),
    listDaemonsets: vi.fn(),
    getDeployment: vi.fn(),
    getDaemonset: vi.fn(),
    listCustomResources: vi.fn(),
  },
}));

import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import { fetchController, listTraefik, servedGroupName } from "./data";

const deployments = vi.mocked(commands.listDeployments);
const daemonSets = vi.mocked(commands.listDaemonsets);

beforeEach(() => {
  deployments.mockReset();
  daemonSets.mockReset();
});

describe("looking for the proxy", () => {
  /**
   * Both lists came back through `.catch(() => [])`, so a token refused
   * `list deployments` was told Traefik is not installed on a cluster where
   * it serves every host on the page.
   */
  it("says the lookup was refused rather than that there is no proxy", async () => {
    deployments.mockRejectedValue("deployments.apps is forbidden (code: 403)");
    daemonSets.mockResolvedValue([]);

    const controller = await fetchController();

    expect(controller.workload).toBeNull();
    expect(controller.problem?.key).toBe("controllerUnread");
    expect(String(controller.problem?.values?.why)).toContain("forbidden");
  });

  /** Both lists answered and neither holds it: that is "not installed". */
  it("says there is none when both lists answered empty", async () => {
    deployments.mockResolvedValue([]);
    daemonSets.mockResolvedValue([]);

    const controller = await fetchController();

    expect(controller.problem?.key).toBe("traefikNoController");
  });
});

describe("the API group Traefik's kinds are read from", () => {
  const onCluster = (context: string) =>
    useClusterStore.setState({ currentContext: context });

  /**
   * Remembered once for the whole session, so a v2 cluster opened after a v3
   * one was asked only for `traefik.io`, and its page said the routing could
   * not be read until the app restarted.
   */
  it("is found again on each cluster", async () => {
    vi.mocked(commands.listCustomResources).mockImplementation(
      async (crd: string) => {
        const serves =
          useClusterStore.getState().currentContext === "old"
            ? "traefik.containo.us"
            : "traefik.io";
        if (crd.endsWith(`.${serves}`)) return [];
        throw new Error(
          "Tauri command 'listCustomResources' failed: not found",
          {
            cause: { code: "NOT_FOUND", message: "not found" },
          }
        );
      }
    );

    onCluster("new");
    await listTraefik("ingressroutes");
    expect(servedGroupName()).toBe("traefik.io");

    onCluster("old");
    await expect(listTraefik("ingressroutes")).resolves.toEqual([]);
    expect(servedGroupName()).toBe("traefik.containo.us");

    onCluster("new");
    expect(servedGroupName()).toBe("traefik.io");
  });
});
