import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/commands", () => ({ commands: {} }));

import { TooltipProvider } from "@/components/ui/tooltip";
import { DataFreshness } from "./data-freshness";
import { useClusterStore } from "@/stores/clusterStore";

const wrap = (ui: React.ReactNode) =>
  render(<TooltipProvider>{ui}</TooltipProvider>);

const UPDATED = Date.now();

beforeEach(() => {
  useClusterStore.setState({ isConnected: true });
});

describe("what the freshness reading claims", () => {
  it("says nothing until data has arrived", () => {
    const { container } = wrap(<DataFreshness live />);
    expect(container).toBeEmptyDOMElement();
  });

  it("only says live when a watch is actually feeding the view", () => {
    wrap(<DataFreshness dataUpdatedAt={UPDATED} live />);
    expect(screen.getByText("live")).toBeInTheDocument();
  });

  it("says polling on a view that only re-reads on a timer", () => {
    wrap(<DataFreshness dataUpdatedAt={UPDATED} />);
    expect(screen.getByText("polling")).toBeInTheDocument();
    expect(screen.queryByText("live")).not.toBeInTheDocument();
  });

  it("never says live while disconnected, watch or no watch", () => {
    useClusterStore.setState({ isConnected: false });
    const { rerender } = wrap(<DataFreshness dataUpdatedAt={UPDATED} live />);
    expect(screen.getByText("offline")).toBeInTheDocument();
    expect(screen.queryByText("live")).not.toBeInTheDocument();

    rerender(
      <TooltipProvider>
        <DataFreshness dataUpdatedAt={UPDATED} />
      </TooltipProvider>
    );
    expect(screen.getByText("offline")).toBeInTheDocument();
  });

  it("distinguishes the three states without relying on colour", () => {
    const dot = () =>
      document.querySelector("span.rounded-full")?.className ?? "";

    const polled = (
      <TooltipProvider>
        <DataFreshness dataUpdatedAt={UPDATED} />
      </TooltipProvider>
    );
    const { rerender, unmount } = wrap(
      <DataFreshness dataUpdatedAt={UPDATED} live />
    );
    expect(dot()).toContain("bg-ok");

    rerender(polled);
    expect(dot()).toContain("bg-fg-fnt");

    useClusterStore.setState({ isConnected: false });
    rerender(polled);
    // A ring rather than a fill: the shape carries it too.
    expect(dot()).toContain("border-fg-fnt");
    unmount();
  });
});
