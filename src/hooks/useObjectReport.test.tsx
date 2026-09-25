import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const listEvents = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(
  async () => []
);
vi.mock("@/lib/commands", () => ({
  commands: {
    getAppInfo: vi.fn(async () => ({ version: "4.20.1" })),
    listEvents: (...args: unknown[]) => listEvents(...args),
    getResourceConnections: vi.fn(async () => null),
  },
}));

const vendorReport = vi.fn();
vi.mock("@/integrations", async (original) => ({
  ...(await original<object>()),
  useCapabilities: (key: string) =>
    key === "object.report" ? [vendorReport] : [],
}));

import { useClusterStore } from "@/stores/clusterStore";
import { useDisplaySettingsStore } from "@/stores/displaySettingsStore";
import { useObjectReport } from "./useObjectReport";

const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={["/crds/traefik.io/ingressroutes/web/shop"]}>
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {children}
    </QueryClientProvider>
  </MemoryRouter>
);

const subject = { kind: "IngressRoute", name: "shop", namespace: "web" };
const resource = {
  apiVersion: "traefik.io/v1alpha1",
  spec: { routes: [] },
  status: null,
  conditions: [
    {
      type: "Ready",
      status: "False",
      reason: "BackendMissing",
      message: null,
      lastTransitionTime: null,
    },
  ],
};

const build = (capturing: boolean) =>
  renderHook(() => useObjectReport(subject, resource, undefined, capturing), {
    wrapper,
  });

describe("the report of any object", () => {
  beforeEach(() => {
    listEvents.mockReset();
    listEvents.mockResolvedValue([]);
    vendorReport.mockReset();
    vendorReport.mockReturnValue(null);
    useClusterStore.setState({ currentContext: "prod-eu" });
    useDisplaySettingsStore.setState({ resourceColouring: "full" });
  });

  /** The frame is on every detail page; a Share nobody pressed must read nothing. */
  it("reads nothing and builds nothing until Share is pressed", async () => {
    const { result } = build(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.report).toBeNull();
    expect(listEvents).not.toHaveBeenCalled();
  });

  /** Every kind that keeps conditions gets them, without its page having to ask. */
  it("finds the object's conditions wherever it keeps them", async () => {
    const { result } = build(true);
    await waitFor(() => expect(result.current.report).not.toBeNull());
    const conditions = result.current.report!.sections.find(
      (section) => section.id === "conditions"
    );
    expect(conditions?.body).toMatchObject({
      type: "conditions",
      rows: [{ type: "Ready", role: "err" }],
    });
  });

  /** A vendor knows its own objects; its sections belong in the report of one. */
  it("asks the vendors about the object, with its group, spec and status", async () => {
    vendorReport.mockReturnValue([
      {
        id: "routes",
        title: "Routes",
        icon: "",
        body: { type: "text", text: "Host(`shop.example.com`)" },
      },
    ]);
    const { result } = build(true);
    await waitFor(() => expect(result.current.report).not.toBeNull());
    expect(vendorReport).toHaveBeenCalledWith(
      expect.objectContaining({
        group: "traefik.io",
        kind: "IngressRoute",
        spec: resource.spec,
      }),
      expect.any(Function)
    );
    expect(result.current.report!.sections.map((s) => s.id)).toContain(
      "routes"
    );
  });

  /** A refused events read is a line in "Not read", never an empty list of events. */
  it("says the events could not be read rather than that there are none", async () => {
    listEvents.mockRejectedValue(new Error("events is forbidden"));
    const { result } = build(true);
    await waitFor(() =>
      expect(result.current.report?.notRead.join(" ")).toContain("forbidden")
    );
    const events = result.current.report!.sections.find(
      (section) => section.id === "events"
    );
    expect(events?.unread).toContain("forbidden");
  });

  /** The sender's colouring choice travels with the file rather than being reset to the default. */
  it("carries the sender's resource colouring setting", async () => {
    useDisplaySettingsStore.setState({ resourceColouring: "off" });
    const { result } = build(true);
    await waitFor(() => expect(result.current.report).not.toBeNull());
    expect(result.current.report!.colouring).toBe("off");
  });

  /** The link lands a colleague with Rubick on the same page. */
  it("links back to the page the report was made on", async () => {
    const { result } = build(true);
    await waitFor(() => expect(result.current.report).not.toBeNull());
    expect(result.current.report!.link).toContain("ingressroutes");
  });
});
