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
