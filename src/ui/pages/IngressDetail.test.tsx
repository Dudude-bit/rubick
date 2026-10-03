import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks")>()),
  useResourceDetail: vi.fn(),
}));

const vendor = vi.hoisted(() => ({
  terminated: null as boolean | null,
  /** `false` when no controller has spoken for the host at all. */
  answered: true,
  error: null as Error | null,
}));
vi.mock("@/hooks/useIngressTls", () => ({
  useIngressTls: () => ({
    available: true,
    of: (_: unknown, host: string) =>
      vendor.answered
        ? {
            host,
            terminated: vendor.terminated,
            by: { key: "verbatimLine", values: { said: "shop-cert" } },
          }
        : undefined,
    isPending: false,
    error: vendor.error,
  }),
}));

vi.mock("@/lib/commands", () => ({
  commands: new Proxy({}, { get: () => vi.fn(async () => null) }),
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { useResourceDetail } from "@/hooks";
import type { IngressInfo } from "@/generated/types";
import { IngressDetail } from "./IngressDetail";

const shop: IngressInfo = {
  name: "shop",
  namespace: "web",
  className: "gce",
  rules: [
    {
      host: "shop.example.com",
      paths: [
        {
          path: "/",
          pathType: "Prefix",
          backendService: "storefront",
          backendPort: "80",
          resourceBackend: null,
        },
      ],
    },
  ],
  defaultBackend: null,
  loadBalancerIps: ["34.1.2.3"],
  tlsHosts: [],
  tlsConfigs: [],
  hasCatchAllTls: false,
  labels: {},
  annotations: {},
  createdAt: null,
};

const open = (tab: string) => {
  vi.mocked(useResourceDetail).mockReturnValue({
    name: "shop",
    namespace: "web",
    resource: shop,
    isLoading: false,
    error: null,
    yaml: "",
    copyYaml: vi.fn(),
    activeTab: tab,
    setActiveTab: vi.fn(),
    goBack: vi.fn(),
    refetch: vi.fn(),
    deleteMutation: { mutate: vi.fn(), isPending: false },
  } as unknown as ReturnType<typeof useResourceDetail>);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>
          <IngressDetail />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
};

beforeEach(() => {
  vendor.terminated = null;
  vendor.answered = true;
  vendor.error = null;
});

/** The role token that paints an element's text, its own or inherited. */
function colourOf(element: Element): string | undefined {
  for (let at: Element | null = element; at; at = at.parentElement) {
    const token =
      /(?:^|\s)(text-(?:fg(?:-\w+)?|warn|err|ok|info))(?=\s|$)/.exec(
        at.getAttribute("class") ?? ""
      );
    if (token) return token[1];
  }
  return undefined;
}

/** How each place on the page paints the host's TLS, in one state. */
function paints(terminated: boolean | null) {
  cleanup();
  vendor.terminated = terminated;
  const words =
    terminated === null ? "TLS not checked" : terminated ? "TLS" : "no TLS";
  const marker = terminated === null ? "?" : terminated ? "HTTPS" : "HTTP";
  open("access");
  // A tab is also called "TLS"; the badge is the one outside the tab list.
  const badge = colourOf(
    screen.getAllByText(words).find((at) => !at.closest("[role='tab']"))!
  );
  const scheme = colourOf(screen.getByText(marker));
  cleanup();
  open("overview");
  const fact = colourOf(
    screen.getByText(
      terminated === null
        ? "TLS not checked"
        : terminated
          ? "0 hosts"
          : "none — traffic is unencrypted",
      { selector: "dd *, dd" }
    )
  );
  return { badge, scheme, fact };
}

describe("an Ingress whose certificate the controller could not read", () => {
  /**
   * The page took "could not tell" for silence and let an empty `spec.tls`
   * decide: "no TLS" in the header and an `http://` URL on the Access tab,
   * for a host GKE serves over HTTPS. Fails if `null` is read as `false`.
   */
  it("says TLS was not checked and offers no scheme", () => {
    open("access");

    expect(screen.queryByText("no TLS")).toBeNull();
    expect(screen.getAllByText("TLS not checked").length).toBeGreaterThan(0);
    expect(screen.queryByText("HTTP")).toBeNull();
    expect(screen.queryByText("HTTPS")).toBeNull();
    expect(screen.queryByLabelText("Open in Browser")).toBeNull();
  });

  /** The other side of the same branch: a controller that said no. */
  it("says no TLS when the controller said it serves plain HTTP", () => {
    vendor.terminated = false;
    open("access");

    expect(screen.getAllByText("no TLS").length).toBeGreaterThan(0);
    expect(screen.getByText("HTTP")).toBeTruthy();
    expect(screen.getByLabelText("Open in Browser")).toBeTruthy();
  });

  /**
   * A controller that was never answered — the question failed — has not
   * said no either. Only `terminated: null` was tested, so reading the
   * failure as `false` put "no TLS" and `http://` back unnoticed.
   */
  it("says TLS was not checked when the controllers could not be asked", () => {
    vendor.answered = false;
    vendor.error = new Error("the ingress controller did not answer");
    open("rules");

    expect(screen.queryByText(/no TLS/)).toBeNull();
    expect(screen.getByText(/· TLS not checked/)).toBeTruthy();
  });

  /**
   * The words differed and the colour did not: the header badge, the TLS fact
   * and the `?` on the Access tab were painted as "TLS" is, so only reading
   * the word told "not checked" from "has TLS".
   */
  it("paints not checked apart from TLS and from no TLS everywhere it says so", () => {
    const unknown = paints(null);
    const yes = paints(true);
    const no = paints(false);

    for (const place of ["badge", "scheme", "fact"] as const) {
      expect(unknown[place], place).toBeDefined();
      expect(unknown[place], place).not.toBe(yes[place]);
      expect(unknown[place], place).not.toBe(no[place]);
    }
  });
});
