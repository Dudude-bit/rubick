import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useClusterSummary", () => ({
  useClusterSummary: () => ({
    namespaces: [],
    podCount: 3,
    problemCount: 0,
    problemsTruncated: 0,
    isLoading: false,
  }),
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { useClusterStore } from "@/stores/clusterStore";
import { StatusBar } from "./StatusBar";

beforeEach(() => {
  useClusterStore.setState({
    currentContext: "prod",
    isConnected: true,
    connectedThrough: "direct",
    isLoading: false,
    isAuthenticating: false,
    error: null,
    errorContext: null,
    pendingContext: null,
  });
});

describe("which way the session goes", () => {
  /** A session through kubectl is a different session: no deadline of its own, and kubectl's plugin doing the talking. The bar has to say so or the reader debugs the wrong path. */
  it("names the proxy when the app's own credentials were refused", () => {
    useClusterStore.setState({ connectedThrough: "kubectl_proxy" });
    render(
      <TooltipProvider>
        <StatusBar />
      </TooltipProvider>
    );
    expect(screen.getByText("through kubectl proxy")).toBeInTheDocument();
  });

  it("says nothing about the path when it is the ordinary one", () => {
    render(
      <TooltipProvider>
        <StatusBar />
      </TooltipProvider>
    );
    expect(screen.queryByText("through kubectl proxy")).toBeNull();
    expect(screen.getByText("3 pods")).toBeInTheDocument();
  });
});
