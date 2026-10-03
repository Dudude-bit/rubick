import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { CustomResourceInfo } from "@/generated/types";

const mesh = vi.hoisted(() => ({
  objects: new Map<string, unknown[]>(),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    listCustomResources: (crd: string) =>
      Promise.resolve(mesh.objects.get(crd) ?? []),
    listServiceBacking: () =>
      Promise.reject(
        new Error("Tauri command 'listServiceBacking' failed: forbidden", {
          cause: {
            code: "PERMISSION_DENIED",
            message: "services is forbidden",
          },
        })
      ),
  },
}));

const { default: IstioPage } = await import("./page");
const { KINDS } = await import("./data");
const { en } = await import("@/i18n/catalogue");

function custom(
  kind: string,
  name: string,
  spec: Record<string, unknown>
): CustomResourceInfo {
  return {
    name,
    namespace: "mesh",
    uid: name,
    apiVersion: "networking.istio.io/v1",
    kind,
    spec,
    status: null,
    labels: {},
    annotations: {},
    createdAt: null,
    ownerReferences: [],
    generation: null,
  };
}

const edge = custom("Gateway", "edge", {
  servers: [
    { port: { number: 80, protocol: "HTTP" }, hosts: ["shop.mesh.test"] },
  ],
});

function routing(
  route: Array<{ destination: { host: string; subset?: string } }>,
  rules: CustomResourceInfo[] = []
) {
  mesh.objects.set(KINDS.gateways, [edge]);
  mesh.objects.set(KINDS.virtualServices, [
    custom("VirtualService", "shop-vs", {
      hosts: ["shop.mesh.test"],
      gateways: ["edge"],
      http: [{ route }],
    }),
  ]);
  mesh.objects.set(KINDS.destinationRules, rules);
}

async function openHost() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/integrations/istio?tab=routes"]}>
        {children}
      </MemoryRouter>
    </QueryClientProvider>
  );
  render(<IstioPage />, { wrapper });
  await userEvent.click(await screen.findByText("shop.mesh.test"));
}

/** The box of the chain whose first line is `text`. */
const cell = (text: string) =>
  screen
    .getAllByText(text)
    .find((element) => element.classList.contains("truncate"))?.parentElement;

beforeEach(() => mesh.objects.clear());

describe("a destination whose origin the unread Services list would decide", () => {
  /**
   * Only the chain, which draws the first destination, said the origin was
   * unread; a second destination read as a hostname like any external one.
   * Fails if a destination past the first loses the mark.
   */
  it("marks it on the rule, wherever it stands among the destinations", async () => {
    routing([
      { destination: { host: "shop" } },
      { destination: { host: "shop.mesh" } },
    ]);

    await openHost();

    expect(
      screen.getByText(en.empty.maybeThisClustersService)
    ).toBeInTheDocument();
  });

  /**
   * The chain said "Services not read" in the same box a confirmed Service
   * is drawn in, and a subset only that Service's rule defines read as
   * defined. Fails if either box is drawn as known.
   */
  it("draws its chain in the unknown tone, the subset included", async () => {
    routing(
      [{ destination: { host: "shop.mesh", subset: "v1" } }],
      [
        custom("DestinationRule", "shop-dr", {
          host: "shop.mesh.svc.cluster.local",
          subsets: [{ name: "v1" }],
        }),
      ]
    );

    await openHost();

    expect(cell("shop.mesh")).toHaveClass("border-dashed");
    expect(cell("v1")).toHaveClass("border-dashed");
    expect(cell("v1")).not.toHaveClass("text-err");
    expect(cell("v1")).toHaveTextContent(en.empty.subsetUnconfirmed);
  });
});
