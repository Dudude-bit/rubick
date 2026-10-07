import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/commands", () => ({ commands: {} }));

import { TooltipProvider } from "@/components/ui/tooltip";
import { DataFreshness } from "./data-freshness";
import { useClusterStore } from "@/stores/clusterStore";
import { useLocaleStore } from "@/stores/localeStore";

const wrap = (ui: React.ReactNode) =>
  render(<TooltipProvider>{ui}</TooltipProvider>);

const UPDATED = Date.now();

beforeEach(() => {
  useClusterStore.setState({ isConnected: true });
  useLocaleStore.setState({ choice: null });
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

  /**
   * Lena read "замедлено · 0 с" beside a page title and could not tell what
   * was slowed or what the bare age meant. Fails if the face goes back to a
   * word without its subject or an age without "назад".
   */
  it("says in Russian what is slowed and how long ago it read", () => {
    useLocaleStore.setState({ choice: "ru" });
    wrap(<DataFreshness dataUpdatedAt={Date.now() - 5000} slowed />);
    expect(screen.getByText("опрос реже обычного")).toBeInTheDocument();
    expect(screen.getByText(/^\d+\s*с назад$/)).toBeInTheDocument();
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

describe("the room the reading takes", () => {
  /**
   * The Events toolbar is right-aligned, so the label growing from "polling"
   * to "polled less often · 3s ago" pushed every control left of it by about
   * 100px each time the poll backed off, and clicks aimed at Warnings landed
   * on the limit menu. Fails if the box sizes to the current word alone.
   */
  it("keeps the width of its widest reading whatever it says now", () => {
    const { container } = wrap(<DataFreshness dataUpdatedAt={UPDATED} />);
    const reserved = [
      ...container.querySelectorAll<HTMLElement>("[data-text]"),
    ].map((ghost) => ghost.dataset.text);

    expect(screen.getByText("polling")).toBeInTheDocument();
    expect(reserved).toEqual(
      expect.arrayContaining(["polled less often", "offline", "59m ago"])
    );
    expect(container.textContent).not.toContain("polled less often");
  });
});
