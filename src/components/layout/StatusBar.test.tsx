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

let renewal = "scheduled";
vi.mock("@/hooks/useCredentialRenewal", () => ({
  useRenewal: () => renewal,
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { useClusterStore } from "@/stores/clusterStore";
import { StatusBar } from "./StatusBar";

beforeEach(() => {
  renewal = "scheduled";
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

describe("what will interrupt the reader next", () => {
  /**
   * The one renewal state worth a permanent chip: it predicts the sign-in
   * screen. The quiet states must not light it, or the line stops being read.
   */
  it("warns only when renewing quietly turned out to need a person", () => {
    renewal = "needsYou";
    render(
      <TooltipProvider>
        <StatusBar />
      </TooltipProvider>
    );
    expect(screen.getByText("sign-in needed")).toBeInTheDocument();
  });

  it.each([
    "scheduled",
    "noDeadline",
    "passed",
    "failed",
    "delegated",
    "unknown",
  ])("says nothing while renewal is %s", (state) => {
    renewal = state;
    render(
      <TooltipProvider>
        <StatusBar />
      </TooltipProvider>
    );
    expect(screen.queryByText("sign-in needed")).toBeNull();
  });
});
