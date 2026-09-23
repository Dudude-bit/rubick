import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/commands", () => ({
  commands: {
    listDeployments: vi.fn(),
    listDaemonsets: vi.fn(),
    getDeployment: vi.fn(),
    getDaemonset: vi.fn(),
  },
}));

import { commands } from "@/lib/commands";
import { fetchController } from "./data";

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
