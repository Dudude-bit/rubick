import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const listEvents = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(
  async () => []
);
const getResourceConnections = vi.fn<(...args: unknown[]) => Promise<unknown>>(
  async () => null
);
const listNodes = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(
  async () => []
);
vi.mock("@/lib/commands", () => ({
  commands: {
    getAppInfo: vi.fn(async () => ({ version: "4.20.1" })),
    listEvents: (...args: unknown[]) => listEvents(...args),
    getResourceConnections: (...args: unknown[]) =>
      getResourceConnections(...args),
    listNodes: (...args: unknown[]) => listNodes(...args),
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
    getResourceConnections.mockReset();
    getResourceConnections.mockResolvedValue(null);
    listNodes.mockReset();
    listNodes.mockResolvedValue([]);
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

  /**
   * The expensive read is the neighbourhood graph, polled while the dialog
   * is open; an IngressRoute has no graph, so the case above could not see
   * it read. A pod does.
   */
  it("reads no graph and no nodes for a pod until Share is pressed", async () => {
    renderHook(
      () =>
        useObjectReport(
          { kind: "Pod", name: "web-1", namespace: "shop" },
          { status: {} },
          undefined,
          false
        ),
      { wrapper }
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getResourceConnections).not.toHaveBeenCalled();
    expect(listNodes).not.toHaveBeenCalled();
  });

  /**
   * The dialog keys the public-target tick and the published link on the
   * capture stamp. Minted inside the report, it moved on every watch tick
   * and took both away a second after they were given.
   */
  it("keeps one capture stamp while the object's data moves", async () => {
    const { result, rerender } = renderHook(
      ({ object }: { object: unknown }) =>
        useObjectReport(subject, object, undefined, true),
      { wrapper, initialProps: { object: resource as unknown } }
    );
    await waitFor(() => expect(result.current.report).not.toBeNull());
    const first = result.current.report!;
    await new Promise((resolve) => setTimeout(resolve, 5));
    rerender({ object: { ...resource, spec: { routes: [{}] } } });
    await waitFor(() => expect(result.current.report).not.toBe(first));
    expect(result.current.report!.capturedAt).toBe(first.capturedAt);
  });

  /**
   * A section that says in place it could not be read has to be in "Not
   * read" too; the Node report said "Pods tab not opened" above a footer
   * saying everything was read.
   */
  it("says in Not read every section the page could not read", async () => {
    const { result } = renderHook(
      () =>
        useObjectReport(
          subject,
          resource,
          () => ({
            sections: [
              {
                id: "node-pods",
                order: 20,
                title: "Pods on this node",
                icon: "",
                unread: "The Pods tab was not open",
                body: { type: "table", columns: [], rows: [], more: null },
              },
            ],
          }),
          true
        ),
      { wrapper }
    );
    await waitFor(() => expect(result.current.report).not.toBeNull());
    expect(result.current.report!.notRead).toContain(
      "Pods on this node: The Pods tab was not open"
    );
  });

  /** The page's own part is given what the frame read once Share was pressed. */
  it("hands the page the capture moment and the nodes that stopped reporting", async () => {
    listNodes.mockResolvedValue([
      {
        name: "n2",
        status: { conditions: [{ type: "Ready", status: "Unknown" }] },
      },
    ]);
    const contribute = vi.fn(() => ({}));
    const { result } = renderHook(
      () => useObjectReport(subject, resource, contribute, true),
      { wrapper }
    );
    await waitFor(() =>
      expect(contribute).toHaveBeenLastCalledWith(
        expect.objectContaining({
          silent: expect.objectContaining({ size: 1 }),
          capturedAt: result.current.report?.capturedAt,
        })
      )
    );
  });

  /**
   * A Secret has connections and no path traffic takes to it; its report
   * said no Service selects "these pods", so traffic never reaches it.
   */
  it("draws what connects to a Secret and no traffic path to it", async () => {
    const secret = {
      kind: "Secret",
      name: "db",
      namespace: "shop",
      existence: "present",
      facts: null,
    };
    getResourceConnections.mockResolvedValue({
      subject: secret,
      edges: [],
      stops: [],
      published: [],
      notLookedAt: [],
    });
    const { result } = renderHook(
      () =>
        useObjectReport(
          { kind: "Secret", name: "db", namespace: "shop" },
          {},
          undefined,
          true
        ),
      { wrapper }
    );
    await waitFor(() =>
      expect(
        result.current.report?.sections.some((s) => s.id === "connections")
      ).toBe(true)
    );
    expect(
      result.current.report!.sections.some((s) => s.id === "traffic")
    ).toBe(false);
  });
});
