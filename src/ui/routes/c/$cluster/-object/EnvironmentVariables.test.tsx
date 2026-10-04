import { describe, expect, it, vi } from "vite-plus/test";
import { waitFor } from "@testing-library/react";

vi.mock("@/lib/commands", () => ({
  commands: {
    getConfigmapData: vi.fn(async () => ({
      values: { LOG_LEVEL: "debug" },
      withheld: {},
      binary: {},
    })),
  },
}));

import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { renderWithRouter } from "@/test/render";
import { EnvironmentVariables } from "./EnvironmentVariables";

/**
 * The pod's environment and the ConfigMap's own page read the same values
 * with namespace and name in opposite orders, so an edit saved on the page
 * never reached a pod's env — and a ConfigMap `app` in `prod` shared an entry
 * with a ConfigMap `prod` in `app`. Fails if the env keys the values anywhere
 * but where the page invalidates them.
 */
describe("a pod's environment", () => {
  it("re-reads a ConfigMap once its page has changed a key", async () => {
    const { client } = await renderWithRouter(
      <EnvironmentVariables
        namespace="prod"
        envFrom={[]}
        env={[
          {
            name: "LOG_LEVEL",
            value: null,
            valueFrom: {
              sourceType: "configMapKeyRef",
              name: "app",
              key: "LOG_LEVEL",
              fieldPath: null,
              resource: null,
              optional: null,
            },
          },
        ]}
      />,
      {
        at: "/c/prod/pods/prod/api-0",
        route: "/c/$cluster/$resource/$namespace/$name",
      }
    );
    await waitFor(() =>
      expect(commands.getConfigmapData).toHaveBeenCalledTimes(1)
    );

    await client.invalidateQueries({
      queryKey: queryKeys.configMapData("prod", "app"),
    });
    expect(commands.getConfigmapData).toHaveBeenCalledTimes(2);
  });
});
