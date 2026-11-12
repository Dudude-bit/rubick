import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { ServiceBacking, ServiceInfo } from "@/generated/types";

const commands = vi.hoisted(() => ({
  listServiceBacking: vi.fn(),
  listServiceHealthInputs: vi.fn(),
}));

vi.mock("@/lib/commands", () => ({ commands }));

const { BackingAround, HealthCell } = await import("./ServiceHealthCell");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { useClusterStore } = await import("@/stores/clusterStore");

const WEB = {
  name: "web",
  namespace: "net",
  type: "ClusterIP",
  selector: { app: "web" },
} as unknown as ServiceInfo;

function published(ready: number): ServiceBacking["published"][number] {
  return {
    service: {
      kind: "Service",
      name: "web",
      namespace: "net",
      existence: "present",
      facts: null,
    },
    source: "slices",
    slices: 1,
    ready,
    draining: 0,
    notReady: 0,
    unrouted: 0,
    unroutedReady: 0,
    ports: [],
    endpoints: [],
    whole: true,
    unpublished: [],
    stop: null,
  };
}

function page(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <BackingAround>{children}</BackingAround>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  commands.listServiceBacking.mockReset();
  commands.listServiceHealthInputs.mockReset();
  useClusterStore.setState({ namespaceScope: ["net"] });
});

describe("the Services list's health column", () => {
  /**
   * The list keeps its full read; the compact one is the shell's. Fails if
   * the column stops drawing from `listServiceBacking`, or starts paying
   * for a second read of the same Services.
   */
  it("draws each row's verdict from the list's own full read", async () => {
    commands.listServiceBacking.mockResolvedValue({
      services: [],
      published: [published(3)],
    });

    render(page(<HealthCell service={WEB} />));

    expect(await screen.findByText("3 ready")).toBeTruthy();
    expect(commands.listServiceBacking).toHaveBeenCalledWith("net");
    expect(commands.listServiceHealthInputs).not.toHaveBeenCalled();
  });

  /**
   * root-web's row read only "no endpoints", its cause behind a hover, while
   * the Deployments list beside it led with the refusal. Fails if a row's
   * reason is not drawn beside its badge.
   */
  it("says why beside the badge rather than only on hover", async () => {
    commands.listServiceBacking.mockResolvedValue({
      services: [],
      published: [
        {
          ...published(0),
          slices: 0,
          stop: {
            reason: "podsRefused",
            service: published(0).service,
            selector: "app=web",
            workloads: [
              {
                kind: "Deployment",
                name: "web",
                namespace: "net",
                existence: "present",
                facts: null,
              },
            ],
            said: 'pods "web-7d9-x" is forbidden: violates PodSecurity "restricted:latest": runAsNonRoot != true (pod or container "app" must set securityContext.runAsNonRoot=true)',
          },
        },
      ],
    });

    render(page(<HealthCell service={WEB} />));

    expect(await screen.findByTestId("verdict-reason")).toHaveTextContent(
      "Pod Security restricted refuses its pods: 1 check fails"
    );
  });

  /** A refused namespace is not checked, never a Service with no endpoints. */
  it("reads a refused namespace as not checked", async () => {
    commands.listServiceBacking.mockRejectedValue(
      new Error("services is forbidden")
    );

    render(page(<HealthCell service={WEB} />));

    expect(await screen.findByText("not checked")).toBeTruthy();
  });
});
