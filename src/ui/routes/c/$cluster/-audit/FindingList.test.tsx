import { describe, expect, it, vi } from "vite-plus/test";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

  /**
   * The files were named once, then the kubeconfig changed and naming them
   * failed: the answer held from before named files the app no longer reads
   * the context from. Fails if the fix goes on naming them, or does not say
   * why it cannot.
   */
  it("names no files from before a failed ask, and says why with a way to ask again", async () => {
    useClusterStore.setState({ currentContext: "default" });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <RuleExplained
          rule="pss-privileged"
          kind="Pod"
          finding={{
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
          }}
          subject={{ kind: "Pod", namespace: "shop", name: "web-x" }}
        />
      </QueryClientProvider>
    );
    await screen.findByText(/^KUBECONFIG=\/home\/me/);
    cliKubeconfig.mockImplementationOnce(() =>
      Promise.reject(new Error('"default" is named in both a.yaml and b.yaml'))
    );
    await act(() => client.invalidateQueries());
    expect(
      await screen.findByText(
        "KUBECONFIG=FILES kubectl --context default delete pod web-x --namespace shop"
      )
    ).toBeInTheDocument();
    expect(screen.getByText(/could not be told/).textContent).toContain(
      "is named in both a.yaml and b.yaml"
    );
    cliKubeconfig.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Ask again" }));
    await waitFor(() => expect(cliKubeconfig).toHaveBeenCalledWith("default"));
  });
});
