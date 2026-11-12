import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const read = vi.hoisted(() => ({
  summary: {
    namespaces: [],
    podCount: 12,
    refused: false,
    namespaceList: "listed",
    isLoading: false,
  },
  attention: { items: [], total: 0, checks: [], complete: true, worst: null },
  scoped: {
    data: {
      counts: { pods: 0 },
      pods: {
        read: { running: 0, pending: 0, succeeded: 0, failed: 0, unknown: 0 },
        complete: true,
      },
      problems: [],
      problemsTruncated: 0,
      unconfirmed: [],
      unread: [],
    },
    isPlaceholderData: false,
    dataUpdatedAt: 1,
    freshness: { everyMs: 10_000, slowRead: false },
  },
}));
vi.mock("@/hooks/useClusterSummary", () => ({
  useClusterSummary: () => read.summary,
}));
vi.mock("@/hooks/useAttention", () => ({
  useAttention: () => read.attention,
}));
vi.mock("@/hooks/useClusterOverview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useClusterOverview")>()),
  useScopedOverview: () => read.scoped,
}));
vi.mock("@/hooks/useCredentialRenewal", () => ({
  useRenewal: () => "scheduled",
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { useClusterStore } from "@/stores/clusterStore";
import { StatusBar } from "./StatusBar";

beforeEach(() => {
  useClusterStore.setState({
    namespaceScope: ["lena"],
    currentContext: "acme-staging",
    isConnected: true,
    live: ["acme-staging"],
    isLoading: false,
    isAuthenticating: false,
    error: null,
    turnedAt: 0,
  });
});

const strip = (missing?: Parameters<typeof StatusBar>[0]["missing"]) =>
  render(
    <TooltipProvider>
      <StatusBar missing={missing} />
    </TooltipProvider>
  );

describe("the strip's count over a namespace the cluster does not have", () => {
  /**
   * Lena's strip read "0 pods · 0 problems in lena" for a namespace that is
   * not there, the words of a healthy empty one. Fails if the strip counts
   * a missing namespace, or stops saying it is missing.
   */
  it("says the namespace is not there instead of counting it", () => {
    strip({ missing: ["lena"], whole: true, checking: false });
    const counts = screen.getByTestId("scope-counts");
    expect(counts).toHaveTextContent("no namespace lena");
    expect(counts).not.toHaveTextContent("0 pods");
    expect(counts).not.toHaveTextContent("0 problems");
  });

  /** Fails if the namespaces that are there lose their count to the one that is not. */
  it("counts the namespaces that are there and names the one that is not", () => {
    useClusterStore.setState({ namespaceScope: ["lena-sandbox", "lena"] });
    strip({ missing: ["lena"], whole: false, checking: false });
    const counts = screen.getByTestId("scope-counts");
    expect(counts).toHaveTextContent("0 pods");
    expect(screen.getByTestId("scope-missing-status")).toHaveTextContent(
      "no namespace lena"
    );
  });
});
