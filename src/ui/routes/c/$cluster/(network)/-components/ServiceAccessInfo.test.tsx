import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { ServiceInfo } from "@/generated/types";
import { testQueryClient } from "@/test/render";
import { ServiceAccessInfo } from "./ServiceAccessInfo";

vi.mock("@/lib/commands", () => ({
  commands: {
    listServicesIn: () => Promise.resolve({ rows: [], unread: [] }),
  },
}));

function wrap(ui: ReactNode) {
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>
  );
}

/** external-demo as `get_service` returns it: no cluster IP, an alias in spec.externalName. */
const externalDemo: ServiceInfo = {
  name: "external-demo",
  namespace: "k8s-gui-test",
  uid: "1",
  type: "ExternalName",
  sessionAffinity: "None",
  clusterIp: null,
  externalName: "example.com",
  externalIps: [],
  loadBalancerIps: [],
  ports: [],
  selector: {},
  labels: {},
  annotations: {},
  createdAt: null,
};

describe("an ExternalName Service's Access tab", () => {
  /** It read the empty cluster IP and printed "N/A" with a copy button. Fails if the alias is not what the tab shows. */
  it("names the DNS name the Service resolves to", () => {
    wrap(<ServiceAccessInfo service={externalDemo} onForward={() => {}} />);
    expect(screen.getByText("example.com")).toBeTruthy();
    expect(screen.queryByText("N/A")).toBeNull();
  });
});

/** public-api as `get_service` returns it on a cluster with no load balancer implementation. */
const publicApi: ServiceInfo = {
  name: "public-api",
  namespace: "net",
  uid: "2",
  type: "LoadBalancer",
  sessionAffinity: "None",
  clusterIp: "10.101.40.12",
  externalName: null,
  externalIps: [],
  loadBalancerIps: [],
  ports: [
    {
      name: "http",
      port: 80,
      targetPort: "http",
      nodePort: 31827,
      protocol: "TCP",
    },
  ],
  selector: { app: "api" },
  labels: {},
  annotations: {},
  createdAt: null,
};

describe("a LoadBalancer Service's Access tab", () => {
  /** It listed only the two in-cluster names, as if the Service were internal, while its Overview said the NodePort answers on every node. Fails if the NodePort or the missing address's verdict is dropped. */
  it("lists its NodePort and says why it has no balancer address", async () => {
    wrap(<ServiceAccessInfo service={publicApi} onForward={() => {}} />);
    expect(screen.getByText("<any-node-ip>:31827")).toBeTruthy();
    expect(await screen.findByText("nothing assigns it")).toBeTruthy();
    expect(
      screen.getByText("public-api.net.svc.cluster.local:80")
    ).toBeTruthy();
  });
});

describe("a ClusterIP Service's way in from this machine", () => {
  const ledger: ServiceInfo = {
    ...externalDemo,
    name: "ledger",
    namespace: "team-blind",
    type: "ClusterIP",
    clusterIp: "10.43.12.7",
    externalName: null,
    ports: [
      {
        name: null,
        port: 80,
        targetPort: "8080",
        nodePort: null,
        protocol: "TCP",
      },
    ],
  };

  /**
   * ledger's header dimmed Port forward for no access while this tab's button
   * opened the dialog. Fails if the tab forwards past the reason its page gives.
   */
  it("holds its Port forward to the page's own access answer", () => {
    const onForward = vi.fn();
    wrap(
      <ServiceAccessInfo
        service={ledger}
        onForward={onForward}
        forwardReason="Your access does not allow this"
      />
    );
    const button = screen.getByRole("button", { name: "Port forward" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    button.click();
    expect(onForward).not.toHaveBeenCalled();
  });
});
