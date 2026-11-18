import { describe, expect, it, vi } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { AuditFinding } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";

const cliKubeconfig = vi.fn((context: string) =>
  Promise.resolve(`/home/me/.kube/${context}.yaml:/home/me/.kube/config`)
);
vi.mock("@/lib/commands", () => ({
  commands: { cliKubeconfig: (context: string) => cliKubeconfig(context) },
}));

const { RuleExplained } = await import("./FindingList");

describe("the fix a finding offers to copy", () => {
  /**
   * Two kubeconfig files can each call a cluster `default`. Fails if the
   * command shown leaves out the files the app read the context on screen
   * from, so a terminal reading its own file deletes the other cluster's pod.
   */
  it("names the files the app read the cluster on screen from", async () => {
    useClusterStore.setState({ currentContext: "default" });
    const finding: AuditFinding = {
      rule: "pss-privileged",
      severity: "high",
      what: [
        {
          says: "set",
          at: { list: "ephemeralContainers", container: "debugger" },
          field: "securityContext.privileged",
          value: "true",
        },
      ],
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RuleExplained
          rule="pss-privileged"
          kind="Pod"
          finding={finding}
          subject={{ kind: "Pod", namespace: "shop", name: "web-x" }}
        />
      </QueryClientProvider>
    );
    expect(
      await screen.findByText(
        "KUBECONFIG=/home/me/.kube/default.yaml:/home/me/.kube/config kubectl --context default delete pod web-x --namespace shop"
      )
    ).toBeInTheDocument();
    expect(cliKubeconfig).toHaveBeenCalledWith("default");
  });
});
